// Learning: the voice coach (Review › Voice).
import { formatTime } from "../../learning/browser/core.js";
import {
  badgeMarkup, buttonMarkup, emptyMarkup, escapeHtml, helpTipMarkup, icon, iconButtonMarkup,
  metaMarkup,
} from "../ui/ui.js";
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import { learningEnabled, SPEECH_LOCALES, state } from "../../app.js";
import { persistAppSection, persistPreferences, readStorageArray, storeLocalCopy } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { renderSettings } from "../settings/settings-page.js";
import { isRomanizableLanguage } from "../player/subtitle-display.js";
import { saveSubtitlePreferences } from "../player/subtitle-search.js";
import { libraryChapterName } from "../library/library-page.js";
import {
  currentPronunciationPracticeItem, playPronunciationCue, pronunciationPracticePayload,
  pronunciationPracticeQueue, pronunciationQueueIndex, stepPronunciationQueue,
} from "./learning-state.js";
import { ensureLearningPreset } from "./vocabulary-cards.js";
import { ensureStudyRomanizations, studyChapterCatalog } from "./study-vocabulary.js";
import { languageName } from "./study-decks.js";
import { renderReview } from "./review-quiz.js";

export let reviewMode = localStorage.getItem("blackline-review-mode") === "voice" ? "voice" : "cards";

export let voiceChat = {
  chatId: crypto.randomUUID(),
  mode: localStorage.getItem("blackline-voice-mode") === "practice" ? "practice" : "live",
  messages: [],
  livePresetId: "",
  livePresetLabel: "",
  livePresetContext: "",
  providerLive: false,
  liveStarting: false,
  providerConversationId: "",
  liveSeen: new Set(),
  listening: false,
  speaking: false,
  pending: false,
  interim: "",
  error: "",
  bridgeAvailable: null,
  draft: "",
  refocusTextAfterTurn: false,
};
export let voiceRecognition = null;
let voiceSpeechGeneration = 0;
let voiceLiveIdleTimer = null;
let voiceTranscriptSyncTimer = null;
let voiceUsageUiTimer = null;
export let voiceUsageActiveSince = 0;
export let voiceUsageSegments = readStorageArray("blackline-voice-usage");
let durableVoiceUsage = { ready: false, usedMs: 0, remainingMs: 0, active: null, asOf: Date.now() };
export let browserCoachStatus = null;
export let browserCoachChecking = false;
let browserCoachAction = "";
let browserCoachInstanceId = "";
let browserCoachHelperConnected = false;
let browserCoachConnecting = false;
let browserCoachVersionMismatch = false;
export let coachProviders = [];
export let coachProviderId = localStorage.getItem("blackline-coach-provider") || "chatgpt-browser";
export let voiceLivePresetId = localStorage.getItem("blackline-live-preset") || "top-100";
export let voiceLiveAssistance = localStorage.getItem("blackline-live-assistance") === "unassisted" ? "unassisted" : "assisted";

export const voiceAudio = {
  speakReplies: localStorage.getItem("blackline-voice-speak-replies") !== "0",
  autoContinue: localStorage.getItem("blackline-voice-auto-continue") !== "0",
  voiceURI: localStorage.getItem("blackline-voice-tts-uri") || "",
  rate: Math.max(0.7, Math.min(1.3, Number(localStorage.getItem("blackline-voice-tts-rate")) || 0.96)),
  inputLanguage: localStorage.getItem("blackline-voice-input-language") || "auto",
};
const VOICE_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const VOICE_USAGE_REFERENCE_LIMIT_MS = 3 * 60 * 60 * 1000;

const COACH_LIVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function speechLocale(language = state.targetLanguage) {
  const code = String(language || "").toUpperCase();
  return normalizeLearningLocale(code, code === state.targetLanguage ? state.targetLocale : code === state.baseLanguage ? state.baseLocale : "");
}

// The voice coach's saved preferences, from the server's copy of the app state.
export function applyVoicePreferences(prefs) {
  reviewMode = prefs.reviewMode === "voice" ? "voice" : "cards";
  coachProviderId = String(prefs.coachProviderId || "chatgpt-browser");
  voiceChat.mode = prefs.voiceMode === "practice" ? "practice" : "live";
  voiceLivePresetId = String(prefs.voiceLivePresetId || "top-100");
  voiceLiveAssistance = prefs.voiceLiveAssistance === "unassisted" ? "unassisted" : "assisted";
  voiceAudio.speakReplies = prefs.voiceAudio?.speakReplies !== false;
  voiceAudio.autoContinue = prefs.voiceAudio?.autoContinue !== false;
  voiceAudio.voiceURI = String(prefs.voiceAudio?.voiceURI || "");
  voiceAudio.rate = Math.max(0.7, Math.min(1.3, Number(prefs.voiceAudio?.rate) || 0.96));
  voiceAudio.inputLanguage = String(prefs.voiceAudio?.inputLanguage || "auto");
  if (Array.isArray(prefs.voiceUsageSegments)) voiceUsageSegments = prefs.voiceUsageSegments.slice(-256);
}

// The latest conversation for the current languages, and a live session that is still open.
export function restoreVoiceSession(snapshot) {
  const transcriptCandidates = state.coachTranscripts
    .filter((session) => session && String(session.providerId || coachProviderId) === coachProviderId
      && String(session.targetLanguage || state.targetLanguage) === state.targetLanguage
      && String(session.baseLanguage || state.baseLanguage) === state.baseLanguage)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const persistedSessions = Array.isArray(snapshot.coachSessions) ? snapshot.coachSessions : [];
  const activeNative = persistedSessions
    .filter((session) => session?.nativeVoice === true
      && session?.conversationId
      && String(session.providerId || "") === coachProviderId
      && String(session.targetLanguage || "") === state.targetLanguage
      && String(session.baseLanguage || "") === state.baseLanguage
      && normalizeLearningLocale(state.targetLanguage, session.targetLocale) === state.targetLocale
      && normalizeLearningLocale(state.baseLanguage, session.baseLocale) === state.baseLocale
      && Date.now() - Number(session.updatedAt || 0) < COACH_LIVE_IDLE_TIMEOUT_MS)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
  const transcript = activeNative
    ? transcriptCandidates.find((session) => session.id === activeNative.chatId) || null
    : transcriptCandidates[0];
  if (transcript) {
    voiceChat.chatId = activeNative?.chatId || transcript.id || voiceChat.chatId;
    voiceChat.messages = (Array.isArray(transcript.messages) ? transcript.messages : []).slice(-200).map((message) => ({
      ...message,
      mode: message.mode === "live" || message.mode === "practice" ? message.mode : (transcript.mode === "live" ? "live" : "practice"),
    }));
    voiceChat.liveSeen = new Set(voiceChat.messages.map((message) => message.providerEntryId).filter(Boolean));
  }
  if (activeNative) {
    voiceChat.chatId = activeNative.chatId;
    voiceChat.providerConversationId = String(activeNative.conversationId || "");
    voiceChat.livePresetId = String(activeNative.presetId || "");
    voiceChat.livePresetLabel = String(activeNative.presetLabel || "");
    voiceChat.livePresetContext = String(activeNative.presetContext || "");
    voiceLiveAssistance = activeNative.assistanceMode === "unassisted" ? "unassisted" : "assisted";
    if (voiceChat.livePresetId) voiceLivePresetId = voiceChat.livePresetId;
  }
}

function resetVoiceChat({ preserveMode = true, nextMode = null, persistCurrent = true } = {}) {
  if (voiceLiveIdleTimer) clearTimeout(voiceLiveIdleTimer);
  voiceLiveIdleTimer = null;
  if (voiceChat.providerLive || voiceChat.liveStarting) stopProviderLiveVoice();
  try { voiceRecognition?.abort?.(); } catch {}
  voiceRecognition = null;
  speechSynthesis?.cancel?.();
  voiceSpeechGeneration += 1;
  const previousMode = nextMode || (preserveMode ? voiceChat.mode : (localStorage.getItem("blackline-voice-mode") === "practice" ? "practice" : "live"));
  if (persistCurrent) persistVoiceChatSession();
  voiceChat = {
    chatId: crypto.randomUUID(),
    mode: previousMode === "practice" ? "practice" : "live",
    messages: [],
    livePresetId: "",
    livePresetLabel: "",
    livePresetContext: "",
    providerLive: false,
    liveStarting: false,
    providerConversationId: "",
    liveSeen: new Set(),
    listening: false,
    speaking: false,
    pending: false,
    interim: "",
    error: "",
    bridgeAvailable: voiceChat.bridgeAvailable,
    draft: "",
    refocusTextAfterTurn: false,
  };
  renderReview();
}

export function selectedCoachProvider() {
  return coachProviders.find((provider) => provider.id === coachProviderId) || coachProviders[0] || {
    id: "chatgpt-browser",
    label: "ChatGPT in your browser",
    model: "account-selected",
    kind: "browser-subscription",
    enabled: true,
  };
}

export function setCoachProvider(providerId, { reset = true } = {}) {
  const provider = coachProviders.find((item) => item.id === providerId && item.enabled);
  if (!provider || provider.id === coachProviderId) return;
  if (reset && voiceChat.mode === "live") void closeLiveCoachSession({ reset: false });
  coachProviderId = provider.id;
  localStorage.setItem("blackline-coach-provider", coachProviderId);
  persistPreferences();
  if (reset) resetVoiceChat();
  else {
    renderSettings();
    renderVoiceChatStage();
  }
}

export async function refreshCoachProviders() {
  try {
    const payload = await fetchJson("/api/coach/providers");
    coachProviders = Array.isArray(payload.providers) ? payload.providers.filter((provider) => provider?.id && provider.enabled) : [];
    if (!coachProviders.some((provider) => provider.id === coachProviderId)) {
      coachProviderId = payload.defaultProviderId || coachProviders[0]?.id || "chatgpt-browser";
      localStorage.setItem("blackline-coach-provider", coachProviderId);
    }
  } catch {
    if (!coachProviders.length) coachProviders = [{ id: "chatgpt-browser", label: "ChatGPT in your browser", model: "account-selected", kind: "browser-subscription", enabled: true }];
  }
  renderSettings();
  renderVoiceChatStage();
}

export async function refreshBrowserCoachStatus() {
  const previousAvailability = voiceChat.bridgeAvailable;
  const previousError = voiceChat.error;
  browserCoachChecking = true;
  renderBrowserCoachStatus();
  try {
    const query = browserCoachInstanceId ? `?instanceId=${encodeURIComponent(browserCoachInstanceId)}` : "";
    const status = await fetchJson(`/api/browser-coach/status${query}`);
    browserCoachStatus = status;
    const versionMismatch = Boolean(status.available && status.expectedExtensionVersion && status.extensionVersion && status.expectedExtensionVersion !== status.extensionVersion);
    browserCoachVersionMismatch = versionMismatch;
    voiceChat.bridgeAvailable = Boolean(status.available);
    if (versionMismatch) {
      voiceChat.error = `Language Coach extension update required: ${status.extensionVersion} → ${status.expectedExtensionVersion}. Reload the unpacked extension in Edge before using the coach.`;
    } else if (status.available) {
      // A healthy heartbeat only proves that the extension is connected. It must not erase
      // a request-level failure (ChatGPT load/send/response timeout), otherwise Voice Chat
      // appears to silently drop the learner's turn a few seconds after the real error.
      if (/^Language Coach (?:browser extension is (?:not connected|unavailable)|extension update required)/i.test(String(voiceChat.error || ""))) {
        voiceChat.error = "";
      }
    }
    else voiceChat.error = "Language Coach browser extension is not connected.";
  } catch (error) {
    browserCoachStatus = { available: false, error: error.message || "Language Coach browser extension is unavailable." };
    browserCoachVersionMismatch = false;
    voiceChat.bridgeAvailable = false;
    voiceChat.error = error.message || "Language Coach browser extension is unavailable.";
  } finally {
    browserCoachChecking = false;
    renderBrowserCoachStatus();
  }
  if (reviewMode === "voice" && (previousAvailability !== voiceChat.bridgeAvailable || previousError !== voiceChat.error)) {
    renderVoiceChatStage();
  }
}

export async function openBrowserCoachExtensionFolder() {
  const visiblePath = $("#settings-browser-coach-path")?.textContent?.trim() || "";
  if (visiblePath && visiblePath !== "browser-extension") {
    try { await navigator.clipboard?.writeText?.(visiblePath); } catch {}
  }
  try {
    let isBrave = false;
    try { isBrave = Boolean(await navigator.brave?.isBrave?.()); } catch {}
    const browser = isBrave ? "brave" : /Edg\//.test(navigator.userAgent) ? "edge" : /Chrome\//.test(navigator.userAgent) ? "chrome" : null;
    const result = await postJson("/api/browser-coach/open-extension-folder", { browser });
    let copied = false;
    if (result.path) {
      try {
        await navigator.clipboard?.writeText?.(result.path);
        copied = true;
      } catch {}
    }
    browserCoachAction = result.path
      ? [
        "Opened the helper folder.",
        result.extensionsPageOpened ? "Opened the Extensions page." : "",
        copied ? "Copied its path." : "",
        `Folder: ${result.path}`,
      ].filter(Boolean).join(" ")
      : "Opened the helper folder.";
  } catch (error) {
    browserCoachAction = error.message || "Could not open the extension folder.";
  }
  renderBrowserCoachStatus();
}

function saveVoiceAudioPreferences() {
  localStorage.setItem("blackline-voice-speak-replies", voiceAudio.speakReplies ? "1" : "0");
  localStorage.setItem("blackline-voice-auto-continue", voiceAudio.autoContinue ? "1" : "0");
  localStorage.setItem("blackline-voice-tts-uri", voiceAudio.voiceURI || "");
  localStorage.setItem("blackline-voice-tts-rate", String(voiceAudio.rate));
  localStorage.setItem("blackline-voice-input-language", String(voiceAudio.inputLanguage || "auto"));
  persistPreferences();
}

function normalizedVoiceUsageSegments(now = Date.now()) {
  const windowStart = now - VOICE_USAGE_WINDOW_MS;
  const normalized = voiceUsageSegments.map((segment) => ({
    startAt: Math.max(0, Number(segment?.startAt) || 0),
    endAt: Math.max(0, Number(segment?.endAt) || 0),
  })).filter((segment) => segment.startAt > 0 && segment.endAt > segment.startAt && segment.endAt > windowStart)
    .map((segment) => ({ startAt: Math.max(segment.startAt, windowStart), endAt: Math.min(segment.endAt, now) }))
    .filter((segment) => segment.endAt > segment.startAt)
    .slice(-256);
  voiceUsageSegments = normalized;
  return normalized;
}

function voiceUsageMs(now = Date.now()) {
  if (durableVoiceUsage.ready) {
    const baseline = Math.max(0, Number(durableVoiceUsage.usedMs) || 0);
    const activeDelta = durableVoiceUsage.active && now > Number(durableVoiceUsage.asOf || 0)
      ? now - Number(durableVoiceUsage.asOf || now)
      : 0;
    return baseline + Math.max(0, activeDelta);
  }
  const segments = normalizedVoiceUsageSegments(now);
  let total = segments.reduce((sum, segment) => sum + (segment.endAt - segment.startAt), 0);
  if (voiceUsageActiveSince > 0) {
    total += Math.max(0, now - Math.max(voiceUsageActiveSince, now - VOICE_USAGE_WINDOW_MS));
  }
  return total;
}

export async function refreshVoiceUsageStatus({ render = false } = {}) {
  try {
    const payload = await fetchJson("/api/coach/usage");
    durableVoiceUsage = {
      ready: true,
      usedMs: Math.max(0, Number(payload.usedMs) || 0),
      remainingMs: Math.max(0, Number(payload.remainingMs) || 0),
      active: payload.active && typeof payload.active === "object" ? payload.active : null,
      asOf: Math.max(0, Number(payload.asOf) || Date.now()),
    };
    const activeMatchesCurrent = Boolean(
      durableVoiceUsage.active
      && durableVoiceUsage.active.chatId === voiceChat.chatId
      && (!voiceChat.providerConversationId || durableVoiceUsage.active.conversationId === voiceChat.providerConversationId),
    );
    if (activeMatchesCurrent) {
      voiceChat.providerLive = true;
      voiceChat.liveStarting = false;
      if (!voiceChat.providerConversationId) voiceChat.providerConversationId = String(durableVoiceUsage.active.conversationId || "");
      if (!voiceUsageUiTimer) voiceUsageUiTimer = setInterval(updateVoiceUsageDisplay, 1000);
    } else if (voiceChat.providerLive && !voiceChat.liveStarting) {
      voiceChat.providerLive = false;
      if (voiceUsageUiTimer) clearInterval(voiceUsageUiTimer);
      voiceUsageUiTimer = null;
    }
    updateVoiceUsageDisplay();
    if (render) renderVoiceChatStage();
  } catch {
    // Keep the existing browser-cache timer as an offline fallback.
  }
}

function formatVoiceUsage(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function persistVoiceUsage({ immediate = false } = {}) {
  normalizedVoiceUsageSegments();
  localStorage.setItem("blackline-voice-usage", JSON.stringify(voiceUsageSegments));
  persistPreferences({ immediate });
}

function updateVoiceUsageDisplay() {
  const now = Date.now();
  const used = voiceUsageMs(now);
  const remaining = Math.max(0, VOICE_USAGE_REFERENCE_LIMIT_MS - used);
  const usedNode = $("#voice-usage-used");
  const remainingNode = $("#voice-usage-remaining");
  if (usedNode) usedNode.textContent = formatVoiceUsage(used);
  if (remainingNode) remainingNode.textContent = formatVoiceUsage(remaining);
}

function startVoiceUsageClock() {
  if (!durableVoiceUsage.ready && !voiceUsageActiveSince) voiceUsageActiveSince = Date.now();
  if (voiceUsageUiTimer) clearInterval(voiceUsageUiTimer);
  voiceUsageUiTimer = setInterval(updateVoiceUsageDisplay, 1000);
  updateVoiceUsageDisplay();
  void refreshVoiceUsageStatus();
}

export function stopVoiceUsageClock({ persist = true } = {}) {
  const now = Date.now();
  if (!durableVoiceUsage.ready && voiceUsageActiveSince > 0 && now > voiceUsageActiveSince) {
    voiceUsageSegments.push({ startAt: voiceUsageActiveSince, endAt: now });
  }
  voiceUsageActiveSince = 0;
  if (voiceUsageUiTimer) clearInterval(voiceUsageUiTimer);
  voiceUsageUiTimer = null;
  if (persist && !durableVoiceUsage.ready) persistVoiceUsage({ immediate: true });
  updateVoiceUsageDisplay();
  void refreshVoiceUsageStatus();
}

function persistVoiceChatSession({ replace = false } = {}) {
  if (!voiceChat.messages.length && !state.coachTranscripts.some((session) => session?.id === voiceChat.chatId)) return;
  const snapshot = {
    id: voiceChat.chatId,
    mode: voiceChat.mode === "practice" ? "practice" : "live",
    providerId: coachProviderId,
    providerInstanceId: browserCoachInstanceId,
    conversationId: voiceChat.providerConversationId || "",
    targetLanguage: state.targetLanguage,
    baseLanguage: state.baseLanguage,
    presetId: voiceChat.livePresetId || "",
    presetLabel: voiceChat.livePresetLabel || "",
    messages: voiceChat.messages.slice(-200).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: String(message.text || "").slice(0, 4000),
      targetText: String(message.targetText || "").slice(0, 4000),
      romanized: String(message.romanized || "").slice(0, 4000),
      baseText: String(message.baseText || "").slice(0, 4000),
      providerEntryId: String(message.providerEntryId || "").slice(0, 200),
      corrections: Array.isArray(message.corrections) ? message.corrections.slice(0, 6).map((item) => ({
        heard: String(item?.heard || "").slice(0, 240),
        better: String(item?.better || "").slice(0, 240),
        note: String(item?.note || "").slice(0, 500),
      })) : [],
      pronunciation: Array.isArray(message.pronunciation) ? message.pronunciation.slice(0, 6).map((item) => ({
        word: String(item?.word || "").slice(0, 120),
        tip: String(item?.tip || "").slice(0, 500),
      })) : [],
      provider: message.provider && typeof message.provider === "object" ? {
        id: String(message.provider.id || "").slice(0, 80),
        label: String(message.provider.label || "").slice(0, 160),
        model: String(message.provider.model || "").slice(0, 120),
        transport: String(message.provider.transport || "").slice(0, 120),
      } : null,
      acousticScoring: Boolean(message.acousticScoring),
      mode: message.mode === "live" ? "live" : "practice",
      createdAt: Number(message.createdAt) || Date.now(),
    })),
    updatedAt: Date.now(),
  };
  const existing = state.coachTranscripts.findIndex((session) => session?.id === snapshot.id);
  if (existing >= 0) state.coachTranscripts.splice(existing, 1, snapshot);
  else state.coachTranscripts.push(snapshot);
  state.coachTranscripts = state.coachTranscripts
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
    .slice(0, 100);
  storeLocalCopy("blackline-coach-transcripts", state.coachTranscripts);
  persistAppSection("coachTranscripts", state.coachTranscripts, { merge: !replace });
}

export function setReviewTab(tab) {
  if (tab === "live" || tab === "practice") {
    const nextVoiceMode = tab === "practice" ? "practice" : "live";
    if (nextVoiceMode === "practice" && voiceChat.mode === "live" &&
        (voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting)) {
      void closeLiveCoachSession({ reset: false }).then(() => {
        if (voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting) return;
        setReviewTab("practice");
      });
      return;
    }
    reviewMode = "voice";
    localStorage.setItem("blackline-review-mode", "voice");
    if (voiceChat.mode !== nextVoiceMode) {
      persistVoiceChatSession();
      voiceChat.mode = nextVoiceMode;
      localStorage.setItem("blackline-voice-mode", nextVoiceMode);
    }
  } else {
    reviewMode = "cards";
    localStorage.setItem("blackline-review-mode", "cards");
  }
  persistPreferences();
  renderReview();
}

export function reviewTabId() {
  if (reviewMode === "cards") return "cards";
  return voiceChat.mode === "practice" ? "practice" : "live";
}

export function changeReviewTargetLanguage(language) {
  const next = String(language || "").trim().toUpperCase();
  if (!SPEECH_LOCALES[next] || next === state.targetLanguage || next === state.baseLanguage) return;
  const apply = () => {
    persistVoiceChatSession();
    resetVoiceChat({ preserveMode: true, persistCurrent: false });
    saveSubtitlePreferences(state.subdlKey, state.baseLanguage, next, {
      wyzieKey: state.wyzieKey,
      subsourceKey: state.subsourceKey,
    });
    voiceLivePresetId = "top-100";
    localStorage.setItem("blackline-live-preset", "top-100");
    renderReview();
  };
  if (voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting) {
    void closeLiveCoachSession({ reset: false }).then(apply);
  } else {
    apply();
  }
}

function clearCurrentVoiceModeHistory() {
  const mode = voiceChat.mode;
  voiceChat.messages = voiceChat.messages.filter((message) => (message.mode || mode) !== mode);
  voiceChat.error = "";
  voiceChat.interim = "";
  voiceChat.draft = "";
  persistVoiceChatSession({ replace: true });
  renderVoiceChatStage();
}

function speechVoicesForTarget() {
  if (!("speechSynthesis" in window)) return [];
  const locale = speechLocale().toLowerCase();
  const prefix = locale.split("-")[0];
  const voices = window.speechSynthesis.getVoices();
  const matching = voices.filter((voice) => String(voice.lang || "").toLowerCase().startsWith(prefix));
  return matching.length ? matching : voices;
}

function voicePreviewSample(language = state.targetLanguage) {
  const samples = {
    EN: "Hello. Let's practice speaking naturally together.",
    ES: "Hola. Practiquemos una conversación natural juntos.",
    FR: "Bonjour. Entraînons-nous à parler naturellement ensemble.",
    DE: "Hallo. Lass uns gemeinsam natürlich sprechen üben.",
    IT: "Ciao. Facciamo pratica con una conversazione naturale.",
    PT: "Olá. Vamos praticar uma conversa natural juntos.",
    JA: "こんにちは。いっしょに自然な会話を練習しましょう。",
    KO: "안녕하세요. 자연스럽게 대화하는 연습을 해 봅시다.",
    ZH: "你好。我们一起练习自然对话吧。",
    RU: "Привет. Давайте вместе потренируем естественную речь.",
    NL: "Hallo. Laten we samen een natuurlijk gesprek oefenen.",
    PL: "Cześć. Poćwiczmy razem naturalną rozmowę.",
    TR: "Merhaba. Birlikte doğal konuşma pratiği yapalım.",
  };
  return samples[String(language || "").toUpperCase()] || samples.EN;
}

function previewSpeechVoice(voiceURI) {
  if (!("speechSynthesis" in window)) return;
  const voice = window.speechSynthesis.getVoices().find((item) => item.voiceURI === voiceURI);
  if (!voice) return;
  try { voiceRecognition?.abort?.(); } catch {}
  stopVoiceSpeech({ render: false });
  const utterance = new SpeechSynthesisUtterance(voicePreviewSample());
  utterance.voice = voice;
  utterance.lang = voice.lang || speechLocale();
  utterance.rate = Math.max(0.8, Math.min(1.1, voiceAudio.rate));
  window.speechSynthesis.speak(utterance);
}

export function stopVoiceSpeech({ render = true } = {}) {
  voiceSpeechGeneration += 1;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  const changed = voiceChat.speaking;
  voiceChat.speaking = false;
  if (render && changed) renderVoiceChatStage();
}

function scheduleVoiceAutoListen(delayMs = 250) {
  if (!voiceAudio.autoContinue || voiceChat.pending || voiceChat.listening || voiceChat.speaking || voiceChat.providerLive || voiceChat.liveStarting) return;
  if (reviewMode !== "voice" || !$("#view-review")?.classList.contains("is-active")) return;
  window.setTimeout(() => {
    const textInput = $("#voice-text-input");
    if (textInput && (document.activeElement === textInput || textInput.value.trim())) return;
    if (voiceAudio.autoContinue && !voiceChat.pending && !voiceChat.listening && !voiceChat.speaking && !voiceChat.providerLive && !voiceChat.liveStarting && reviewMode === "voice") {
      startVoiceRecognition({ automatic: true });
    }
  }, delayMs);
}

function speakVoiceCoach(text) {
  const spokenText = String(text || "").trim();
  if (voiceChat.providerLive || voiceChat.liveStarting) return;
  if (!spokenText || !voiceAudio.speakReplies || !("speechSynthesis" in window)) {
    scheduleVoiceAutoListen(voiceAudio.speakReplies ? 250 : 80);
    return;
  }
  try { voiceRecognition?.abort?.(); } catch {}
  voiceRecognition = null;
  voiceChat.listening = false;
  stopVoiceSpeech({ render: false });
  const generation = ++voiceSpeechGeneration;
  const utterance = new SpeechSynthesisUtterance(spokenText);
  utterance.lang = speechLocale();
  const voices = speechVoicesForTarget();
  utterance.voice = voices.find((voice) => voice.voiceURI === voiceAudio.voiceURI)
    || voices.find((voice) => String(voice.lang || "").toLowerCase() === utterance.lang.toLowerCase())
    || voices[0]
    || null;
  utterance.rate = voiceAudio.rate;
  const finish = () => {
    if (generation !== voiceSpeechGeneration) return;
    voiceChat.speaking = false;
    renderVoiceChatStage();
    scheduleVoiceAutoListen();
  };
  utterance.onstart = () => {
    if (generation !== voiceSpeechGeneration) return;
    voiceChat.speaking = true;
    renderVoiceChatStage();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  voiceChat.speaking = true;
  renderVoiceChatStage();
  window.speechSynthesis.speak(utterance);
}

async function sendVoiceTurn(transcript, alternatives = [], { inputMode = "speech" } = {}) {
  if (!learningEnabled || !transcript || voiceChat.pending || voiceChat.providerLive || voiceChat.liveStarting) return;
  const turnMode = voiceChat.mode;
  const requestChat = voiceChat;
  const requestChatId = requestChat.chatId;
  const requestProviderInstanceId = browserCoachInstanceId;
  const practiceItem = turnMode === "practice" ? pronunciationPracticePayload(currentPronunciationPracticeItem()) : null;
  if (turnMode === "practice" && !practiceItem) {
    voiceChat.error = "Nothing to practice yet.";
    renderVoiceChatStage();
    return;
  }
  stopVoiceSpeech({ render: false });
  voiceChat.pending = true;
  voiceChat.error = "";
  voiceChat.interim = "";
  voiceChat.refocusTextAfterTurn = inputMode === "text";
  const userTurn = { role: "user", mode: turnMode, text: transcript, alternatives, createdAt: Date.now() };
  voiceChat.messages.push(userTurn);
  persistVoiceChatSession();
  renderVoiceChatStage();
  let replyToSpeak = "";
  try {
    const result = await postJson("/api/coach/voice-turn", {
      chatId: requestChatId,
      providerId: coachProviderId,
      providerInstanceId: requestProviderInstanceId,
      targetLanguage: state.targetLanguage,
      baseLanguage: state.baseLanguage,
      targetLocale: state.targetLocale,
      baseLocale: state.baseLocale,
      mode: turnMode,
      inputMode,
      transcript,
      alternatives,
      practiceItem,
    });
    // Provider calls may finish after the learner changes modes, clears this
    // conversation, or starts a new one. Never put an old response in the
    // wrong thread (or read it out aloud during a different practice session).
    if (!learningEnabled || voiceChat !== requestChat || voiceChat.chatId !== requestChatId
        || voiceChat.mode !== turnMode || !voiceChat.messages.includes(userTurn)) return;
    const output = result.output || result;
    const targetText = output.targetText || output.reply || "";
    voiceChat.messages.push({
      role: "assistant",
      text: targetText,
      targetText,
      romanized: output.romanized || "",
      baseText: output.baseText || "",
      mode: turnMode,
      corrections: output.corrections || [],
      pronunciation: output.pronunciation || [],
      provider: result.provider || null,
      acousticScoring: Boolean(result.capabilities?.acousticScoring ?? result.acousticScoring),
      createdAt: Date.now(),
    });
    persistVoiceChatSession();
    voiceChat.bridgeAvailable = true;
    replyToSpeak = targetText;
  } catch (error) {
    if (learningEnabled && voiceChat === requestChat && voiceChat.chatId === requestChatId
        && voiceChat.mode === turnMode && voiceChat.messages.includes(userTurn)) {
      voiceChat.error = error.message || "Voice correction failed.";
    }
  } finally {
    requestChat.pending = false;
    if (voiceChat === requestChat) renderVoiceChatStage();
  }
  if (replyToSpeak) speakVoiceCoach(replyToSpeak);
}

function liveConversationPresets() {
  const presets = [];
  const current = state.currentSource || {};
  const hasMedia = current.kind && current.kind !== "idle" && current.title && current.title !== "No video loaded";
  if (hasMedia) {
    let relevantWords = [];
    try {
      const chapter = studyChapterCatalog().find((item) => String(item.libraryId) === String(current.libraryId)
        && String(item.fileIndex) === String(current.fileIndex));
      relevantWords = (chapter?.analysis?.words || []).slice(0, 24).map((item) => String(item?.value || item || "").trim()).filter(Boolean);
    } catch {}
    const sourceLabel = String(current.sourceTag || current.title || "").trim();
    presets.push({
      id: "current-media",
      kicker: "Just watched",
      label: `Discuss ${String(current.title).slice(0, 80)}`,
      context: [
        `Discuss the movie or episode the learner just watched: ${current.title}.`,
        sourceLabel && sourceLabel !== current.title ? `Source: ${sourceLabel}.` : "",
        "Ask about plot, characters, memorable scenes, opinions, and predictions. Keep it conversational rather than quizzing mechanically.",
        relevantWords.length ? `Relevant vocabulary from this source: ${relevantWords.join(", ")}.` : "",
      ].filter(Boolean).join(" "),
    });
  }

  const recentCards = state.cards.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 24);
  if (recentCards.length) {
    const items = recentCards.map((card) => {
      const front = String(card.front || "").trim();
      const back = String(card.back || "").trim();
      return back && back !== front ? `${front} — ${back}` : front;
    }).filter(Boolean);
    presets.push({
      id: "recent-words",
      kicker: "Recent words",
      label: `Use ${items.length} learned items in sentences`,
      context: `Practice the learner's recently learned vocabulary in natural sentence contexts. Prompt the learner to understand and actively use these items without simply reading a list: ${items.join("; ")}.`,
    });
  }

  const presetWords = state.learningPreset.language === state.targetLanguage && state.learningPreset.status === "ready"
    ? state.learningPreset.words.filter((item) => Number(item.rank || 0) <= 100).slice(0, 100).map((item) => String(item.value || "").trim()).filter(Boolean)
    : [];
  presets.push({
    id: "top-100",
    kicker: "Core words",
    label: "Review top 100 words",
    context: `Review high-frequency ${state.targetLanguage} vocabulary through natural conversation and short production prompts.${presetWords.length ? ` Prioritize these loaded top-100 items: ${presetWords.join(", ")}.` : ""}`,
  });
  presets.push({
    id: "open-conversation",
    kicker: "Open topic",
    label: "Free conversation",
    context: "Run an open natural conversation appropriate to the learner's level. Follow their interests, keep turns concise, and correct meaningful language errors without interrupting the flow.",
  });
  return presets;
}

function selectedLiveConversationPreset() {
  const presets = liveConversationPresets();
  let selected = presets.find((preset) => preset.id === voiceChat.livePresetId)
    || presets.find((preset) => preset.id === voiceLivePresetId)
    || presets.find((preset) => preset.id === "top-100")
    || presets[0];
  if (!selected) return null;
  if (["top-100", "recent-words"].includes(selected.id)) {
    const languageInstruction = voiceLiveAssistance === "assisted"
      ? `For this session, conduct the conversation mainly in the learner's base language ${state.baseLanguage}, while deliberately eliciting and reviewing the target-language ${state.targetLanguage} items. Use the base language to explain, scaffold, and clarify; ask the learner to produce the reviewed words and short target-language sentences.`
      : `For this session, use ${state.targetLanguage} throughout the conversation. Do not switch to ${state.baseLanguage} unless the learner explicitly asks for help. Review the selected vocabulary through natural target-language prompts and sentences.`;
    selected = { ...selected, context: `${selected.context} ${languageInstruction}` };
  }
  if (!voiceChat.providerConversationId) {
    voiceLivePresetId = selected.id;
    localStorage.setItem("blackline-live-preset", selected.id);
  }
  if (selected.id === "top-100" && state.learningPreset.status !== "loading" &&
      (state.learningPreset.language !== state.targetLanguage || state.learningPreset.status === "idle")) {
    void ensureLearningPreset(state.targetLanguage).then(() => {
      if (reviewMode === "voice" && voiceChat.mode === "live") renderVoiceChatStage();
    }).catch(() => {});
  }
  return selected;
}

function setLiveAssistance(mode) {
  if (voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting) return;
  voiceLiveAssistance = mode === "unassisted" ? "unassisted" : "assisted";
  localStorage.setItem("blackline-live-assistance", voiceLiveAssistance);
  persistPreferences();
  renderVoiceChatStage();
}

function selectLiveConversationPreset(id) {
  if (voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting) return;
  const selected = liveConversationPresets().find((preset) => preset.id === id);
  if (!selected) return;
  voiceLivePresetId = selected.id;
  localStorage.setItem("blackline-live-preset", selected.id);
  persistPreferences();
  if (selected.id === "top-100" && (state.learningPreset.language !== state.targetLanguage || state.learningPreset.status !== "ready")) {
    void ensureLearningPreset(state.targetLanguage).then(() => renderVoiceChatStage()).catch(() => {});
  }
  renderVoiceChatStage();
}

async function startProviderLiveVoice() {
  const provider = selectedCoachProvider();
  if (!learningEnabled || voiceChat.providerLive || voiceChat.liveStarting || voiceChat.mode !== "live") return;
  if (!(provider.supports?.liveVoice || provider.id === "chatgpt-browser")) {
    voiceChat.error = `${coachProviderShortLabel(provider.label) || provider.id} can't hold a live voice conversation.`;
    renderVoiceChatStage();
    return;
  }
  try { voiceRecognition?.abort?.(); } catch {}
  voiceRecognition = null;
  voiceChat.listening = false;
  stopVoiceSpeech({ render: false });
  const requestChat = voiceChat;
  const requestChatId = requestChat.chatId;
  const requestProviderInstanceId = browserCoachInstanceId;
  const startToken = {};
  requestChat.liveStartRequest = startToken;
  const stillStarting = () => learningEnabled && voiceChat === requestChat
    && requestChat.chatId === requestChatId && requestChat.mode === "live"
    && requestChat.liveStartRequest === startToken && requestChat.liveStarting;
  voiceChat.liveStarting = true;
  voiceChat.error = "";
  renderVoiceChatStage();
  try {
    let preset = selectedLiveConversationPreset();
    if (!preset) throw new Error("Choose a conversation preset before starting Live Voice.");
    if (preset.id === "top-100" && (state.learningPreset.language !== state.targetLanguage || state.learningPreset.status !== "ready")) {
      await ensureLearningPreset(state.targetLanguage);
      if (!stillStarting()) return;
      preset = selectedLiveConversationPreset();
      if (!preset) throw new Error("Top 100 vocabulary is not available for this target language.");
    }
    if (!stillStarting()) return;
    const result = await postJson("/api/coach/live-session/start", {
      chatId: requestChatId,
      providerId: provider.id,
      providerInstanceId: requestProviderInstanceId,
      targetLanguage: state.targetLanguage,
      baseLanguage: state.baseLanguage,
      targetLocale: state.targetLocale,
      baseLocale: state.baseLocale,
      assistanceMode: voiceLiveAssistance,
      presetId: preset.id,
      presetLabel: preset.label,
      presetContext: preset.context,
    });
    if (!stillStarting()) {
      // The backend may have created a session after the user cancelled the
      // pending request. Close that specific orphan; never start Edge Voice.
      if (result.session?.conversationId) {
        void postJson("/api/coach/live-session/close", {
          chatId: requestChatId,
          providerId: provider.id,
          providerInstanceId: requestProviderInstanceId,
        }).catch(() => {});
      }
      return;
    }
    const conversationId = String(result.session?.conversationId || "").trim();
    if (!conversationId) throw new Error("The coach provider did not return a live conversation.");
    requestChat.liveStartRequest = null;
    voiceChat.livePresetId = preset.id;
    voiceChat.livePresetLabel = preset.label;
    voiceChat.livePresetContext = preset.context;
    voiceChat.providerConversationId = conversationId;
    window.postMessage({
      source: "language-video-learner-app",
      type: "browser-coach:live-start",
      chatId: requestChatId,
      conversationId,
    }, window.location.origin);
  } catch (error) {
    if (stillStarting()) {
      requestChat.liveStartRequest = null;
      requestChat.liveStarting = false;
      requestChat.error = error.message || "Could not start provider live voice.";
      renderVoiceChatStage();
    }
  }
}

function armProviderLiveIdleTimeout() {
  if (voiceLiveIdleTimer) clearTimeout(voiceLiveIdleTimer);
  if (voiceChat.providerLive) {
    voiceLiveIdleTimer = null;
    return;
  }
  voiceLiveIdleTimer = setTimeout(() => {
    voiceLiveIdleTimer = null;
    if (!voiceChat.providerLive && !voiceChat.providerConversationId) return;
    const expiredChatId = voiceChat.chatId;
    void closeLiveCoachSession().then(() => {
      if (voiceChat.chatId === expiredChatId) return;
      voiceChat.error = "The conversation ended after 5 minutes without talking. Press Start talking to begin a new one.";
      renderVoiceChatStage();
    });
  }, COACH_LIVE_IDLE_TIMEOUT_MS);
}

async function touchProviderLiveSession() {
  if (!voiceChat.chatId || !voiceChat.providerConversationId) return;
  try {
    await postJson("/api/coach/live-session/touch", {
      chatId: voiceChat.chatId,
      providerId: coachProviderId,
      providerInstanceId: browserCoachInstanceId,
      nativeVoice: true,
    });
  } catch {}
}

function stopProviderLiveVoice() {
  if (!voiceChat.providerLive && !voiceChat.liveStarting) return;
  voiceChat.liveStartRequest = null;
  if (!voiceChat.providerLive && !voiceChat.providerConversationId) {
    // The HTTP session creation has not returned yet. Invalidate the pending
    // start; its late response will clean up the backend session if necessary.
    voiceChat.liveStarting = false;
    renderVoiceChatStage();
    return;
  }
  voiceChat.liveStarting = true;
  renderVoiceChatStage();
  window.postMessage({
    source: "language-video-learner-app",
    type: "browser-coach:live-stop",
    chatId: voiceChat.chatId,
    conversationId: voiceChat.providerConversationId || "",
  }, window.location.origin);
}

export async function closeLiveCoachSession({ reset = true } = {}) {
  voiceChat.liveStartRequest = null;
  if (voiceLiveIdleTimer) clearTimeout(voiceLiveIdleTimer);
  voiceLiveIdleTimer = null;
  if (voiceUsageActiveSince) stopVoiceUsageClock();
  const closing = {
    chatId: voiceChat.chatId,
    providerId: coachProviderId,
    providerInstanceId: browserCoachInstanceId,
    conversationId: voiceChat.providerConversationId || "",
    wasProviderLive: Boolean(voiceChat.providerLive || voiceChat.liveStarting),
  };
  persistVoiceChatSession();
  if (closing.wasProviderLive) {
    window.postMessage({
      source: "language-video-learner-app",
      type: "browser-coach:live-stop",
      chatId: closing.chatId,
      conversationId: closing.conversationId,
    }, window.location.origin);
    voiceChat.providerLive = false;
    voiceChat.liveStarting = false;
  }
  try {
    await postJson("/api/coach/live-session/close", {
      chatId: closing.chatId,
      providerId: closing.providerId,
      providerInstanceId: closing.providerInstanceId,
    });
  } catch (error) {
    if (!reset || voiceChat.chatId !== closing.chatId) return;
    voiceChat.error = error.message || "Could not close the live coach session.";
    renderVoiceChatStage();
    return;
  }
  if (voiceChat.chatId === closing.chatId) {
    voiceChat.providerLive = false;
    voiceChat.liveStarting = false;
    voiceChat.providerConversationId = "";
    voiceChat.liveSeen = new Set();
    voiceChat.livePresetId = "";
    voiceChat.livePresetLabel = "";
    voiceChat.livePresetContext = "";
    voiceChat.error = "";
    if (reset) voiceChat.chatId = crypto.randomUUID();
    renderVoiceChatStage();
  }
}

async function enrichLiveRomanization(message) {
  if (!message || message.role !== "assistant" || message.romanized || !message.targetText) return;
  if (!["JA", "KO", "ZH", "RU"].includes(state.targetLanguage)) return;
  try {
    const result = await postJson("/api/subtitles/romanize", {
      language: state.targetLanguage,
      texts: [message.targetText],
    });
    const romanized = String(result.romanized?.[0] || "").trim();
    if (!romanized || message.romanized) return;
    message.romanized = romanized;
    persistVoiceChatSession();
    renderVoiceChatStage();
  } catch {}
}

function mergeProviderLiveTranscript(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  let changed = false;
  for (const entry of entries.slice(0, 20)) {
    const id = String(entry?.id || "").slice(0, 200);
    const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : null;
    const text = String(entry?.text || "").trim().slice(0, 4000);
    if (!id || !role || !text || voiceChat.liveSeen.has(id)) continue;
    voiceChat.liveSeen.add(id);
    const message = role === "assistant"
      ? {
          role,
          mode: "live",
          text,
          targetText: text,
          romanized: "",
          baseText: "",
          providerEntryId: id,
          provider: selectedCoachProvider(),
          providerLive: true,
          createdAt: Date.now(),
        }
      : {
          role,
          mode: "live",
          text,
          providerEntryId: id,
          providerLive: true,
          createdAt: Date.now(),
        };
    voiceChat.messages.push(message);
    changed = true;
    if (role === "assistant") void enrichLiveRomanization(message);
  }
  if (!changed) return;
  armProviderLiveIdleTimeout();
  void touchProviderLiveSession();
  persistVoiceChatSession();
  renderVoiceChatStage();
}

function mergePersistedLiveTranscriptSession(session) {
  if (!session || String(session.id || "") !== String(voiceChat.chatId || "")) return false;
  const sessionConversationId = String(session.conversationId || "");
  if (voiceChat.providerConversationId && sessionConversationId && sessionConversationId !== voiceChat.providerConversationId) return false;
  if (!voiceChat.providerConversationId && sessionConversationId) voiceChat.providerConversationId = sessionConversationId;
  const persistedMessages = Array.isArray(session.messages) ? session.messages : [];
  const byProviderId = new Map(
    voiceChat.messages
      .filter((message) => message?.providerEntryId)
      .map((message) => [String(message.providerEntryId), message]),
  );
  let changed = false;
  for (const persisted of persistedMessages.slice(-200)) {
    if ((persisted?.mode || "live") !== "live") continue;
    const providerEntryId = String(persisted?.providerEntryId || "").slice(0, 200);
    const role = persisted?.role === "assistant" ? "assistant" : persisted?.role === "user" ? "user" : null;
    const text = String(persisted?.text || "").trim().slice(0, 4000);
    if (!providerEntryId || !role || !text) continue;
    voiceChat.liveSeen.add(providerEntryId);
    const existing = byProviderId.get(providerEntryId);
    if (existing) {
      const updates = {
        text,
        targetText: String(persisted.targetText || (role === "assistant" ? text : existing.targetText || "")).slice(0, 4000),
        romanized: String(persisted.romanized || existing.romanized || "").slice(0, 4000),
        baseText: String(persisted.baseText || existing.baseText || "").slice(0, 4000),
      };
      for (const [key, value] of Object.entries(updates)) {
        if (value && existing[key] !== value) {
          existing[key] = value;
          changed = true;
        }
      }
      continue;
    }
    const message = {
      role,
      mode: "live",
      text,
      targetText: role === "assistant" ? String(persisted.targetText || text).slice(0, 4000) : "",
      romanized: role === "assistant" ? String(persisted.romanized || "").slice(0, 4000) : "",
      baseText: role === "assistant" ? String(persisted.baseText || "").slice(0, 4000) : "",
      providerEntryId,
      provider: role === "assistant" ? selectedCoachProvider() : null,
      providerLive: true,
      createdAt: Number(persisted.createdAt) || Date.now(),
    };
    voiceChat.messages.push(message);
    byProviderId.set(providerEntryId, message);
    changed = true;
  }
  if (!changed) return false;
  voiceChat.messages = voiceChat.messages
    .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0))
    .slice(-200);
  const existingSession = state.coachTranscripts.findIndex((item) => String(item?.id || "") === String(session.id || ""));
  if (existingSession >= 0) state.coachTranscripts.splice(existingSession, 1, session);
  else state.coachTranscripts.unshift(session);
  state.coachTranscripts = state.coachTranscripts.slice(0, 100);
  storeLocalCopy("blackline-coach-transcripts", state.coachTranscripts);
  renderVoiceChatStage();
  return true;
}

function liveTranscriptSyncNeeded() {
  return reviewMode === "voice"
    && voiceChat.mode === "live"
    && Boolean(voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting)
    && Boolean($("#view-review")?.classList.contains("is-active"));
}

async function refreshLiveTranscriptFromServer() {
  if (!liveTranscriptSyncNeeded()) return;
  try {
    const payload = await fetchJson("/api/app-state/coachTranscripts");
    const sessions = Array.isArray(payload?.value) ? payload.value : [];
    const matching = sessions.find((session) => String(session?.id || "") === String(voiceChat.chatId || ""))
      || (voiceChat.providerConversationId
        ? sessions.find((session) => String(session?.conversationId || "") === String(voiceChat.providerConversationId))
        : null);
    if (matching) mergePersistedLiveTranscriptSession(matching);
  } catch {}
}

function ensureLiveTranscriptSync() {
  if (!liveTranscriptSyncNeeded()) {
    if (voiceTranscriptSyncTimer) clearInterval(voiceTranscriptSyncTimer);
    voiceTranscriptSyncTimer = null;
    return;
  }
  if (voiceTranscriptSyncTimer) return;
  void refreshLiveTranscriptFromServer();
  voiceTranscriptSyncTimer = setInterval(() => {
    if (!liveTranscriptSyncNeeded()) {
      clearInterval(voiceTranscriptSyncTimer);
      voiceTranscriptSyncTimer = null;
      return;
    }
    void refreshLiveTranscriptFromServer();
  }, 1800);
}

async function enrichProviderLiveTranscript() {
  if (!learningEnabled) return;
  const originChat = voiceChat;
  const originChatId = voiceChat.chatId;
  const pending = voiceChat.messages.filter((message) =>
    message.role === "assistant" && message.providerLive && message.providerEntryId && !message.baseText && message.targetText,
  ).slice(-40);
  if (!pending.length || voiceChat.providerLive || voiceChat.liveStarting) return;
  try {
    const result = await postJson("/api/coach/live-transcript/enrich", {
      providerId: coachProviderId,
      providerInstanceId: browserCoachInstanceId,
      targetLanguage: state.targetLanguage,
      baseLanguage: state.baseLanguage,
      items: pending.map((message) => ({ id: message.providerEntryId, text: message.targetText })),
    });
    if (!learningEnabled || voiceChat !== originChat || voiceChat.chatId !== originChatId) return;
    const byId = new Map((Array.isArray(result.items) ? result.items : []).map((item) => [String(item.id || ""), item]));
    let changed = false;
    for (const message of pending) {
      const item = byId.get(message.providerEntryId);
      if (!item) continue;
      const targetText = String(item.targetText || message.targetText || "").trim();
      const romanized = String(item.romanized || message.romanized || "").trim();
      const baseText = String(item.baseText || "").trim();
      if (targetText) message.targetText = targetText;
      if (romanized) message.romanized = romanized;
      if (baseText) message.baseText = baseText;
      changed = true;
    }
    if (changed) {
      persistVoiceChatSession();
      renderVoiceChatStage();
    }
  } catch (error) {
    if (learningEnabled && voiceChat === originChat && voiceChat.chatId === originChatId) {
      voiceChat.error = `The transcript was saved, but its translations couldn't be added: ${error.message || "unknown error"}`;
      renderVoiceChatStage();
    }
  }
}

export function wireBrowserCoachMessages() {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== "language-video-learner-browser-coach") return;
    if (event.data?.type === "browser-coach:instance") {
      const instanceId = String(event.data.instanceId || "").trim();
      if (/^[A-Za-z0-9._:-]{8,120}$/.test(instanceId)) browserCoachInstanceId = instanceId;
      browserCoachHelperConnected = Boolean(event.data.helperConnected);
      void refreshBrowserCoachStatus();
      return;
    }
    if (event.data?.type === "browser-coach:connect-result") {
      const instanceId = String(event.data.instanceId || "").trim();
      if (/^[A-Za-z0-9._:-]{8,120}$/.test(instanceId)) browserCoachInstanceId = instanceId;
      browserCoachConnecting = false;
      browserCoachHelperConnected = Boolean(event.data.ok);
      browserCoachAction = event.data.ok
        ? "The helper is connected."
        : `The helper didn't connect: ${String(event.data.error || "it did not respond.")}`;
      if (event.data.ok) {
        if (/^Helper connection failed:/i.test(String(voiceChat.error || ""))) voiceChat.error = "";
      } else {
        voiceChat.error = `Helper connection failed: ${String(event.data.error || "Browser helper did not respond.")}`;
      }
      renderVoiceChatStage();
      void refreshBrowserCoachStatus();
      return;
    }
    if (event.data?.type === "browser-coach:live-control-result") {
      if (!learningEnabled || String(event.data.chatId || "") !== voiceChat.chatId) return;
      const controlConversationId = String(event.data.conversationId || "");
      if (event.data.action === "start" && voiceChat.mode !== "live") return;
      if (event.data.action === "start" && !voiceChat.liveStarting) return;
      if (event.data.action === "start" && controlConversationId && voiceChat.providerConversationId && controlConversationId !== voiceChat.providerConversationId) return;
      if (event.data.action === "stop" && controlConversationId && !voiceChat.providerConversationId) return;
      if (event.data.action === "stop" && controlConversationId && voiceChat.providerConversationId && controlConversationId !== voiceChat.providerConversationId) return;
      voiceChat.liveStarting = false;
      if (event.data.action === "start" && event.data.ok) {
        voiceChat.providerLive = true;
        voiceChat.providerConversationId = controlConversationId || voiceChat.providerConversationId || "";
        voiceChat.error = "";
        startVoiceUsageClock();
        armProviderLiveIdleTimeout();
      } else if (event.data.action === "stop" && event.data.ok) {
        voiceChat.providerLive = false;
        voiceChat.error = "";
        stopVoiceUsageClock();
        armProviderLiveIdleTimeout();
        queueMicrotask(() => { void enrichProviderLiveTranscript(); });
      } else {
        if (event.data.action === "start") voiceChat.providerLive = false;
        voiceChat.error = String(event.data.error || "Provider live voice could not be controlled.");
      }
      renderVoiceChatStage();
      return;
    }
    if (event.data?.type === "browser-coach:live-transcript") {
      if (!learningEnabled) return;
      if (String(event.data.chatId || "") !== voiceChat.chatId) return;
      const conversationId = String(event.data.conversationId || "");
      if (voiceChat.providerConversationId && conversationId && conversationId !== voiceChat.providerConversationId) return;
      mergeProviderLiveTranscript(event.data.entries);
    }
  });
}

export function connectBrowserCoach() {
  if (browserCoachConnecting) return;
  browserCoachConnecting = true;
  browserCoachAction = "Connecting the helper…";
  renderBrowserCoachStatus();
  renderVoiceChatStage();
  window.postMessage({
    source: "language-video-learner-app",
    type: "browser-coach:connect",
  }, window.location.origin);
}

function startVoiceRecognition({ automatic = false } = {}) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    if (!automatic) {
      voiceChat.error = "This browser can't turn speech into text. Use Chrome or Edge, or type what you said.";
      renderVoiceChatStage();
    }
    return;
  }
  if (voiceChat.pending || voiceChat.providerLive || voiceChat.liveStarting) return;
  if (voiceChat.speaking || ("speechSynthesis" in window && window.speechSynthesis.speaking)) {
    stopVoiceSpeech({ render: false });
  }
  if (voiceRecognition && voiceChat.listening) {
    try { voiceRecognition.stop(); } catch {}
    return;
  }
  const recognition = new Recognition();
  voiceRecognition = recognition;
  if (voiceAudio.inputLanguage && voiceAudio.inputLanguage !== "auto") {
    const recognitionLanguage = voiceAudio.inputLanguage === "target"
      ? state.targetLanguage
      : voiceAudio.inputLanguage === "base"
        ? state.baseLanguage
        : voiceAudio.inputLanguage;
    recognition.lang = speechLocale(recognitionLanguage);
  }
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;
  recognition.onstart = () => {
    voiceChat.listening = true;
    voiceChat.error = "";
    renderVoiceChatStage();
  };
  recognition.onresult = (event) => {
    let interim = "";
    let finalResult = null;
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalResult = result;
      else interim += result[0]?.transcript || "";
    }
    voiceChat.interim = interim.trim();
    renderVoiceChatStage();
    if (finalResult) {
      const alternatives = [...finalResult].slice(0, 5).map((item) => ({ transcript: item.transcript, confidence: item.confidence }));
      const transcript = alternatives[0]?.transcript?.trim() || "";
      if (transcript) {
        try { recognition.stop(); } catch {}
        void sendVoiceTurn(transcript, alternatives);
      }
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted") {
      voiceChat.listening = false;
      renderVoiceChatStage();
      return;
    }
    if (event.error === "network" && voiceAudio.autoContinue) {
      voiceAudio.autoContinue = false;
      saveVoiceAudioPreferences();
    }
    voiceChat.error = event.error === "not-allowed"
      ? "Microphone permission was denied."
      : event.error === "network"
        ? "Speech recognition network error. Hands-free was paused; keep typing or press TALK to retry."
        : `Speech recognition error: ${event.error || "unknown"}`;
    voiceChat.listening = false;
    renderVoiceChatStage();
  };
  recognition.onend = () => {
    voiceChat.listening = false;
    voiceRecognition = null;
    renderVoiceChatStage();
  };
  try { recognition.start(); }
  catch (error) {
    voiceChat.error = error.message || "Could not start speech recognition.";
    voiceChat.listening = false;
    renderVoiceChatStage();
  }
}

// Microphone for the talk button (not in the shared icon set).
const VOICE_MIC_ICON = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/></svg>';

// "ChatGPT · signed-in browser" (older saved replies) → "ChatGPT".
export function coachProviderShortLabel(label) {
  return String(label || "").split(/\s+·\s+|\s+\(/)[0].replace(/\s+in your browser$/i, "").trim();
}

function voiceMessageMarkup(message, index, { replay = false } = {}) {
  if (message.role === "user") {
    return `<div class="vc-msg is-user"><span class="vc-msg__who">You</span><p class="vc-msg__text">${escapeHtml(message.text)}</p></div>`;
  }
  const targetText = message.targetText || message.text || "";
  const reading = message.romanized && message.romanized !== targetText ? message.romanized : "";
  const via = coachProviderShortLabel(message.provider?.label);
  const notes = [
    ...(message.corrections || []).map((item) => `<li class="vc-note"><span class="vc-note__kind">Correction</span><strong>${escapeHtml(item.better || item.heard)}</strong>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</li>`),
    ...(message.pronunciation || []).map((item) => `<li class="vc-note"><span class="vc-note__kind">Pronunciation</span><strong>${escapeHtml(item.word)}</strong>${item.tip ? `<small>${escapeHtml(item.tip)}</small>` : ""}</li>`),
  ].join("");
  return `<div class="vc-msg is-coach${state.targetLanguage === "JA" ? " is-japanese" : ""}">
    <span class="vc-msg__who">Coach${via ? `<span class="vc-msg__via">${escapeHtml(via)}</span>` : ""}</span>
    <p class="vc-msg__target" lang="${escapeHtml(speechLocale(state.targetLanguage))}">${escapeHtml(targetText)}</p>
    ${reading ? `<p class="vc-msg__line"><span>${state.targetLanguage === "JA" ? "Romaji" : "Reading"}</span>${escapeHtml(reading)}</p>` : ""}
    ${message.baseText ? `<p class="vc-msg__line"><span>${escapeHtml(languageName(state.baseLanguage))}</span>${escapeHtml(message.baseText)}</p>` : ""}
    ${notes ? `<ul class="vc-notes">${notes}</ul>` : ""}
    ${replay && targetText ? buttonMarkup({ label: "Play again", variant: "ghost", size: "sm", icon: "play", className: "vc-msg__replay", attrs: { "data-voice-replay": index } }) : ""}
  </div>`;
}

// The strip above both voice tabs: connection state, which coach, the helper button and a tip.
function voiceCoachBarMarkup({ provider, status, tone, actions = "" }) {
  const providerNeedsBridge = provider.id === "chatgpt-browser";
  const options = (coachProviders.length ? coachProviders : [provider])
    .map((item) => `<option value="${escapeHtml(item.id)}"${item.id === provider.id ? " selected" : ""}>${escapeHtml(coachProviderShortLabel(item.label) || item.id)}</option>`).join("");
  const connected = browserCoachHelperConnected && !browserCoachVersionMismatch;
  const connect = providerNeedsBridge ? buttonMarkup({
    label: browserCoachVersionMismatch ? "Reload the extension" : browserCoachConnecting ? "Connecting…" : connected ? "Connected" : "Connect the helper",
    variant: connected ? "ghost" : "secondary",
    size: "sm",
    icon: connected ? "check" : browserCoachVersionMismatch ? "refresh" : "",
    className: "vc-connect",
    attrs: { id: "voice-connect", disabled: browserCoachConnecting || undefined },
  }) : "";
  const tip = providerNeedsBridge ? helpTipMarkup({
    id: "tip-voice-coach",
    label: "How the coach connects",
    content: "<strong>ChatGPT runs in your own browser.</strong> The helper extension (LVL ChatGPT Coach) opens ChatGPT in a tab where you're signed in and passes each turn back and forth, so it uses your own ChatGPT plan. Set it up once in Settings, Coach; after an app update, reload it in Extensions.",
  }) : "";
  return `<div class="vc-bar">
    <span class="vc-status is-${escapeHtml(tone)}" role="status"><i aria-hidden="true"></i>${escapeHtml(status)}</span>
    <label class="learn-select vc-provider"><span>Coach</span><select id="voice-provider">${options}</select></label>
    ${connect}${tip}
    ${actions ? `<span class="vc-bar__end">${actions}</span>` : ""}
  </div>`;
}

export function renderVoiceChatStage() {
  const stage = $("#review-stage");
  stage?.closest(".review-layout")?.classList.toggle("is-voice-mode", reviewMode === "voice");
  if (!stage || reviewMode !== "voice") {
    if (voiceTranscriptSyncTimer) clearInterval(voiceTranscriptSyncTimer);
    voiceTranscriptSyncTimer = null;
    return;
  }
  const previousInput = $("#voice-text-input");
  const inputSnapshot = previousInput ? {
    value: previousInput.value,
    focused: document.activeElement === previousInput,
    selectionStart: previousInput.selectionStart,
    selectionEnd: previousInput.selectionEnd,
  } : null;
  if (inputSnapshot) voiceChat.draft = inputSnapshot.value;
  const visibleMessages = voiceChat.messages.filter((message) => {
    const messageMode = message.mode || (message.providerLive ? "live" : "practice");
    return messageMode === voiceChat.mode;
  });
  const messages = visibleMessages.map((message, visibleIndex) => voiceMessageMarkup(message, visibleIndex, { replay: voiceChat.mode === "practice" })).join("");
  const support = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const provider = selectedCoachProvider();
  const providerNeedsBridge = provider.id === "chatgpt-browser";
  const providerSupportsNativeLive = voiceChat.mode === "live" && Boolean(provider.supports?.liveVoice || provider.id === "chatgpt-browser");
  const providerBridgeReady = !providerNeedsBridge || (voiceChat.bridgeAvailable && !browserCoachVersionMismatch);
  const bridgeState = !providerNeedsBridge ? "ready"
    : browserCoachVersionMismatch ? "update"
      : voiceChat.bridgeAvailable === true ? "ready"
        : voiceChat.bridgeAvailable === false ? "offline" : "checking";
  const bridgeText = { ready: "Ready", update: "Helper needs a reload", offline: "Helper offline", checking: "Checking…" }[bridgeState];
  // The status chip already says when the helper is offline or needs a reload.
  const shownError = voiceChat.error && !(bridgeState !== "ready" && /^Language Coach (?:browser extension is (?:not connected|unavailable)|extension update required)/i.test(String(voiceChat.error))) ? voiceChat.error : "";

  if (voiceChat.mode === "live") {
    ensureLiveTranscriptSync();
    const liveState = voiceChat.providerLive ? "live" : voiceChat.liveStarting ? "starting" : "idle";
    const liveHelperReady = !providerNeedsBridge || browserCoachHelperConnected;
    const canStartNative = providerSupportsNativeLive && providerBridgeReady && liveHelperReady && !voiceChat.liveStarting;
    const mainAction = voiceChat.providerLive
      ? `<button id="voice-provider-live" class="ui-btn ui-btn--secondary ui-btn--lg vc-start is-stop" type="button"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg><span>Stop</span></button>`
      : `<button id="voice-provider-live" class="ui-btn ui-btn--primary ui-btn--lg vc-start" type="button"${canStartNative ? "" : " disabled"}>${VOICE_MIC_ICON}<span>${voiceChat.liveStarting ? "Starting…" : "Start talking"}</span></button>`;
    const startHint = voiceChat.providerLive || voiceChat.liveStarting || canStartNative ? ""
      : bridgeState === "update" ? "Reload the extension first."
        : bridgeState === "offline" || !liveHelperReady ? "Connect the helper first."
          : bridgeState === "checking" ? "Checking the helper…" : "";
    const hasSession = Boolean(voiceChat.providerConversationId || visibleMessages.length || voiceChat.providerLive || voiceChat.liveStarting);
    const presets = liveConversationPresets();
    const selectedPreset = selectedLiveConversationPreset();
    const presetLocked = Boolean(voiceChat.providerConversationId || voiceChat.providerLive || voiceChat.liveStarting);
    const topics = presets.map((preset) => `<button type="button" class="vc-topic" data-live-preset="${escapeHtml(preset.id)}" aria-pressed="${selectedPreset?.id === preset.id}"${presetLocked ? " disabled" : ""}><span class="vc-topic__kicker">${escapeHtml(preset.kicker)}</span><strong>${escapeHtml(preset.label)}</strong></button>`).join("");
    const assistance = `<div class="ui-segmented vc-assist" role="group" aria-labelledby="vc-language-label">
      <button type="button" class="ui-segmented__item" data-live-assistance="assisted" aria-pressed="${voiceLiveAssistance === "assisted"}"${presetLocked ? " disabled" : ""}>Help in ${escapeHtml(languageName(state.baseLanguage))}</button>
      <button type="button" class="ui-segmented__item" data-live-assistance="unassisted" aria-pressed="${voiceLiveAssistance === "unassisted"}"${presetLocked ? " disabled" : ""}>${escapeHtml(languageName(state.targetLanguage))} only</button>
    </div>`;
    const selectedFocus = voiceChat.livePresetLabel || selectedPreset?.label || "Choose a topic";
    const kicker = liveState === "live" ? "Talking now"
      : liveState === "starting" ? "Opening ChatGPT…"
        : voiceChat.providerConversationId
          ? `<button type="button" class="ui-tip-text vc-launch__open" data-ui-tip="tip-voice-idle" aria-describedby="tip-voice-idle">Conversation open</button><span class="ui-tip-content" id="tip-voice-idle" hidden>It closes by itself after 5 minutes without talking. End it sooner with End conversation.</span>`
          : "Topic";
    const usedMs = voiceUsageMs();
    const remainingMs = Math.max(0, VOICE_USAGE_REFERENCE_LIMIT_MS - usedMs);
    const unpaired = bridgeState === "ready" && !liveHelperReady;
    const status = liveState === "live" ? "Live" : liveState === "starting" ? "Starting…" : unpaired ? "Not connected" : bridgeText;
    const tone = liveState === "live" ? "live" : liveState === "starting" ? "checking" : unpaired ? "checking" : bridgeState;
    stage.innerHTML = `<section class="vc vc--live is-${liveState}" aria-label="Conversation">
      ${voiceCoachBarMarkup({ provider, status, tone })}
      <div class="vc-setup">
        <div class="vc-group">
          <h3 class="vc-label" id="vc-topic-label">Topic</h3>
          <div class="vc-topics" role="group" aria-labelledby="vc-topic-label">${topics}</div>
        </div>
        <div class="vc-group vc-group--row">
          <h3 class="vc-label" id="vc-language-label">Language</h3>
          ${assistance}
        </div>
      </div>
      <div class="vc-launch">
        <div class="vc-orb" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
        <div class="vc-launch__copy">
          <span class="vc-launch__kicker">${kicker}</span>
          <h3 class="vc-launch__title">${escapeHtml(selectedFocus)}</h3>
          ${startHint ? `<p class="vc-launch__hint">${escapeHtml(startHint)}</p>` : ""}
        </div>
        <div class="vc-launch__actions">
          ${mainAction}
          ${hasSession ? buttonMarkup({ label: "End conversation", variant: "ghost", size: "sm", className: "vc-end", attrs: { id: "voice-end-session" } }) : ""}
        </div>
      </div>
      <div class="vc-usage">
        <span class="vc-usage__item">Voice in the last 24 h <strong id="voice-usage-used">${formatVoiceUsage(usedMs)}</strong></span>
        <span class="vc-usage__item">Left of 3 h <strong id="voice-usage-remaining">${formatVoiceUsage(remainingMs)}</strong></span>
        ${visibleMessages.length ? `<span class="vc-usage__item">${visibleMessages.length} message${visibleMessages.length === 1 ? "" : "s"}</span>` : ""}
        ${helpTipMarkup({ id: "tip-voice-usage", label: "About voice time", content: "ChatGPT limits how long voice can run each day. This counts the voice time used from this app in the last 24 hours. 3 hours is a rough guide, not ChatGPT's exact limit." })}
      </div>
      <div id="voice-chat-log" class="vc-log" aria-live="polite">${messages || '<p class="vc-log__empty">What you and the coach say shows up here.</p>'}</div>
      ${shownError ? `<p class="vc-error" role="alert">${escapeHtml(shownError)}</p>` : ""}
    </section>`;
    $("#voice-connect")?.addEventListener("click", () => {
      if (browserCoachVersionMismatch) void openBrowserCoachExtensionFolder();
      else connectBrowserCoach();
    });
    $("#voice-provider-live")?.addEventListener("click", () => {
      if (voiceChat.providerLive) stopProviderLiveVoice();
      else void startProviderLiveVoice();
    });
    $("#voice-end-session")?.addEventListener("click", () => { void closeLiveCoachSession(); });
    $("#voice-provider")?.addEventListener("change", (event) => setCoachProvider(event.target.value));
    $$('[data-live-preset]').forEach((button) => button.addEventListener("click", () => selectLiveConversationPreset(button.dataset.livePreset)));
    $$('[data-live-assistance]').forEach((button) => button.addEventListener("click", () => setLiveAssistance(button.dataset.liveAssistance)));
    const log = $("#voice-chat-log");
    if (log) log.scrollTop = log.scrollHeight;
    updateVoiceUsageDisplay();
    return;
  }

  if (voiceTranscriptSyncTimer) clearInterval(voiceTranscriptSyncTimer);
  voiceTranscriptSyncTimer = null;

  const voices = speechVoicesForTarget();
  const selectedVoice = voices.find((voice) => voice.voiceURI === voiceAudio.voiceURI) || null;
  const voiceRows = voices.map((voice) => `<div class="vc-picker__row${voice.voiceURI === voiceAudio.voiceURI ? " is-selected" : ""}"><button class="vc-picker__pick" type="button" data-voice-select="${escapeHtml(voice.voiceURI)}" aria-pressed="${voice.voiceURI === voiceAudio.voiceURI}"><strong>${escapeHtml(voice.name)}</strong><small>${escapeHtml(voice.lang)}</small></button>${iconButtonMarkup({ icon: "play", label: `Hear ${voice.name}`, variant: "ghost", size: "sm", className: "vc-picker__preview", attrs: { "data-voice-preview": voice.voiceURI } })}</div>`).join("");
  const inputLanguageOptions = [
    ["auto", "Automatic"],
    ["target", languageName(state.targetLanguage)],
    ["base", languageName(state.baseLanguage)],
    ...Object.keys(SPEECH_LOCALES).filter((code) => code !== state.targetLanguage && code !== state.baseLanguage).map((code) => [code, languageName(code)]),
  ].map(([value, label]) => `<option value="${escapeHtml(value)}" ${voiceAudio.inputLanguage === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const micLabel = voiceChat.providerLive ? "Live" : voiceChat.speaking ? "Interrupt" : voiceChat.listening ? "Stop" : "Talk";
  const practiceQueue = pronunciationPracticeQueue();
  if (isRomanizableLanguage(state.targetLanguage) && practiceQueue.some((item) => !item.romanized)) {
    void ensureStudyRomanizations(practiceQueue.map((item) => ({
      value: item.front,
      romanized: item.romanized,
      language: item.targetLanguage || state.targetLanguage,
    })), state.targetLanguage);
  }
  const practiceItem = currentPronunciationPracticeItem(practiceQueue);
  const practiceCanNavigate = practiceQueue.length > 1 && !voiceChat.pending && !voiceChat.listening;
  const practiceInputDisabled = voiceChat.pending || voiceChat.providerLive || voiceChat.liveStarting || !providerBridgeReady || !practiceItem;
  const targetLang = escapeHtml(speechLocale(state.targetLanguage));
  const cueFacts = practiceItem ? [
    ...String(practiceItem.sourceTag || practiceItem.trackLabel || "").split(/\s+·\s+/).map((part) => libraryChapterName({ code: part }) || part),
    practiceItem.context ? formatTime(practiceItem.timestampMs) : "",
  ] : [];
  const practiceTargetMarkup = practiceItem ? `<section class="vc-target" aria-label="Say this">
    <div class="vc-target__head">
      <span class="vc-target__kind">${practiceItem.type === "phrase" ? "Phrase" : "Word"}</span>
      ${badgeMarkup(practiceItem.pronunciationStatus === "mastered" ? "Mastered" : "Practiced")}
      <span class="vc-target__count">${pronunciationQueueIndex + 1} of ${practiceQueue.length}</span>
      <span class="vc-target__nav">
        ${iconButtonMarkup({ icon: "chevron-left", label: "Previous", variant: "ghost", size: "sm", attrs: { id: "voice-practice-prev", disabled: !practiceCanNavigate || undefined } })}
        ${iconButtonMarkup({ icon: "chevron-right", label: "Next", variant: "ghost", size: "sm", attrs: { id: "voice-practice-next", disabled: !practiceCanNavigate || undefined } })}
      </span>
    </div>
    <div class="vc-target__body">
      <div class="vc-target__main">
        <h3 class="vc-target__word" lang="${targetLang}">${escapeHtml(practiceItem.front)}</h3>
        ${practiceItem.romanized && practiceItem.romanized !== practiceItem.front ? `<p class="vc-target__reading">${escapeHtml(practiceItem.romanized)}</p>` : ""}
        ${practiceItem.baseContext || practiceItem.back ? `<p class="vc-target__meaning"><span>${escapeHtml(languageName(state.baseLanguage))}</span>${escapeHtml(practiceItem.baseContext || practiceItem.back)}</p>` : ""}
      </div>
      <figure class="vc-cue">
        <figcaption>From the video</figcaption>
        ${practiceItem.context ? `<blockquote lang="${targetLang}">${escapeHtml(practiceItem.context)}</blockquote>` : '<p class="vc-cue__none">No line saved for this one.</p>'}
        ${metaMarkup(cueFacts)}
        ${buttonMarkup({ label: "Watch the line", variant: "secondary", size: "sm", icon: "play", attrs: { id: "voice-practice-cue-play", disabled: !practiceItem.context || undefined } })}
      </figure>
    </div>
  </section>` : `<section class="vc-target is-empty">${emptyMarkup({ icon: "sparkle", title: "Nothing to practice yet", text: "Words and phrases you've studied show up here, with the line they came from." })}</section>`;
  const status = voiceChat.providerLive ? "Conversation running"
    : voiceChat.speaking ? "Speaking"
      : voiceChat.listening ? "Listening"
        : voiceChat.pending ? "Replying…" : bridgeText;
  const tone = voiceChat.providerLive || voiceChat.speaking || voiceChat.listening ? "live" : voiceChat.pending ? "checking" : bridgeState;
  const placeholder = browserCoachVersionMismatch ? "Reload the extension first"
    : !providerBridgeReady ? "Connect the helper first"
      : !practiceItem ? "Nothing to practice yet"
        : voiceChat.providerLive ? "A conversation is running"
          : support ? "Or type what you said" : "Type what you said";
  const clearButton = visibleMessages.length ? buttonMarkup({ label: "Clear", variant: "ghost", size: "sm", attrs: { id: "voice-new-chat" } }) : "";
  stage.innerHTML = `<section class="vc vc--practice" aria-label="Pronunciation">
    ${voiceCoachBarMarkup({ provider, status, tone, actions: clearButton })}
    ${practiceTargetMarkup}
    <div id="voice-chat-log" class="vc-log" aria-live="polite">${messages || (practiceItem ? '<p class="vc-log__empty">Say it out loud. The coach\'s feedback shows up here.</p>' : "")}${voiceChat.pending ? '<p class="vc-thinking">Coach is replying…</p>' : ""}</div>
    ${voiceChat.interim ? `<p class="vc-interim" lang="${targetLang}">${escapeHtml(voiceChat.interim)}</p>` : ""}
    <div class="vc-composer">
      <button id="voice-mic" class="vc-mic${voiceChat.listening ? " is-listening" : ""}${voiceChat.speaking ? " is-speaking" : ""}" type="button" aria-pressed="${voiceChat.listening}" ${practiceInputDisabled || !support ? "disabled" : ""}>${VOICE_MIC_ICON}<span>${micLabel}</span></button>
      <form id="voice-text-form" class="vc-type">
        <label class="ui-visually-hidden" for="voice-text-input">Type what you said</label>
        <input id="voice-text-input" class="ui-input" type="text" maxlength="4000" autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(voiceChat.draft || "")}" ${practiceInputDisabled ? "disabled" : ""}/>
        <button class="ui-btn ui-btn--secondary" type="submit" ${practiceInputDisabled ? "disabled" : ""}><span>Send</span></button>
      </form>
      ${helpTipMarkup({ id: "tip-voice-recognition", label: "How your speech is checked", content: "Your browser turns what you say into text, and the coach checks that text against the target. It can't score accent or tone." })}
    </div>
    ${shownError ? `<p class="vc-error" role="alert">${escapeHtml(shownError)}</p>` : ""}
    <div class="vc-settings" role="group" aria-label="Voice settings">
      <label class="ui-switch"><input id="voice-speak-toggle" type="checkbox"${voiceAudio.speakReplies ? " checked" : ""}/><span class="ui-switch__track" aria-hidden="true"></span>Read replies aloud</label>
      <span class="vc-settings__item"><label class="ui-switch"><input id="voice-auto-toggle" type="checkbox"${voiceAudio.autoContinue ? " checked" : ""}/><span class="ui-switch__track" aria-hidden="true"></span>Hands-free</label>${helpTipMarkup({ id: "tip-voice-handsfree", label: "About hands-free", content: "After the coach answers, the mic turns on again by itself, so you can keep going without clicking." })}</span>
      <label class="learn-select"><span>Mic language</span><select id="voice-input-language">${inputLanguageOptions}</select></label>
      <div class="vc-voice"><span class="vc-voice__label">Voice</span><details id="voice-picker" class="vc-picker"><summary><span>${selectedVoice ? escapeHtml(selectedVoice.name) : "Automatic"}</span>${icon("chevron-down")}</summary><div class="vc-picker__list"><div class="vc-picker__row${voiceAudio.voiceURI ? "" : " is-selected"}"><button class="vc-picker__pick" type="button" data-voice-select="" aria-pressed="${!voiceAudio.voiceURI}"><strong>Automatic</strong><small>The best ${escapeHtml(languageName(state.targetLanguage))} voice</small></button></div>${voiceRows || '<p class="vc-picker__empty">This browser has no voices for this language.</p>'}</div></details></div>
      <label class="learn-select"><span>Speed</span><select id="voice-tts-rate"><option value="0.8" ${voiceAudio.rate === 0.8 ? "selected" : ""}>0.8×</option><option value="0.96" ${voiceAudio.rate === 0.96 ? "selected" : ""}>0.96×</option><option value="1.05" ${voiceAudio.rate === 1.05 ? "selected" : ""}>1.05×</option><option value="1.15" ${voiceAudio.rate === 1.15 ? "selected" : ""}>1.15×</option><option value="1.3" ${voiceAudio.rate === 1.3 ? "selected" : ""}>1.3×</option></select></label>
    </div>
  </section>`;
  $("#voice-mic")?.addEventListener("click", startVoiceRecognition);
  $("#voice-practice-prev")?.addEventListener("click", () => stepPronunciationQueue(-1));
  $("#voice-practice-next")?.addEventListener("click", () => stepPronunciationQueue(1));
  $("#voice-practice-cue-play")?.addEventListener("click", () => playPronunciationCue(practiceItem));
  $$('[data-voice-replay]').forEach((button) => button.addEventListener("click", () => {
    const message = visibleMessages[Number(button.dataset.voiceReplay)];
    const replayText = String(message?.targetText || message?.text || "").trim();
    if (replayText) speakVoiceCoach(replayText);
  }));
  $("#voice-new-chat")?.addEventListener("click", clearCurrentVoiceModeHistory);
  $("#voice-connect")?.addEventListener("click", () => {
    if (browserCoachVersionMismatch) void openBrowserCoachExtensionFolder();
    else connectBrowserCoach();
  });
  $("#voice-provider")?.addEventListener("change", (event) => setCoachProvider(event.target.value));
  $("#voice-speak-toggle")?.addEventListener("change", (event) => {
    voiceAudio.speakReplies = event.target.checked;
    if (!voiceAudio.speakReplies) stopVoiceSpeech({ render: false });
    saveVoiceAudioPreferences();
    renderVoiceChatStage();
    $("#voice-speak-toggle")?.focus({ preventScroll: true });
  });
  $("#voice-auto-toggle")?.addEventListener("change", (event) => {
    voiceAudio.autoContinue = event.target.checked;
    saveVoiceAudioPreferences();
    renderVoiceChatStage();
    $("#voice-auto-toggle")?.focus({ preventScroll: true });
  });
  $("#voice-input-language")?.addEventListener("change", (event) => {
    voiceAudio.inputLanguage = event.target.value || "auto";
    saveVoiceAudioPreferences();
  });
  $$('[data-voice-select]').forEach((button) => button.addEventListener("click", () => {
    voiceAudio.voiceURI = button.dataset.voiceSelect || "";
    saveVoiceAudioPreferences();
    renderVoiceChatStage();
  }));
  $$('[data-voice-preview]').forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    previewSpeechVoice(button.dataset.voicePreview || "");
  }));
  $("#voice-tts-rate")?.addEventListener("change", (event) => {
    voiceAudio.rate = Math.max(0.7, Math.min(1.3, Number(event.target.value) || 0.96));
    saveVoiceAudioPreferences();
  });
  $("#voice-text-input")?.addEventListener("input", (event) => {
    voiceChat.draft = event.target.value;
  });
  $("#voice-text-input")?.addEventListener("focus", () => {
    if (voiceRecognition && voiceChat.listening) {
      try { voiceRecognition.abort(); } catch {}
    }
  });
  $("#voice-text-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#voice-text-input");
    const text = input?.value.trim();
    if (text) {
      voiceChat.draft = "";
      if (input) input.value = "";
      void sendVoiceTurn(text, [{ transcript: text, confidence: 1 }], { inputMode: "text" });
    }
  });
  const nextInput = $("#voice-text-input");
  const shouldRestoreFocus = !voiceChat.pending && Boolean(inputSnapshot?.focused || voiceChat.refocusTextAfterTurn);
  if (nextInput && shouldRestoreFocus) {
    const selectionStart = inputSnapshot?.focused ? inputSnapshot.selectionStart : nextInput.value.length;
    const selectionEnd = inputSnapshot?.focused ? inputSnapshot.selectionEnd : nextInput.value.length;
    queueMicrotask(() => {
      const current = $("#voice-text-input");
      if (!current || current.disabled) return;
      current.focus({ preventScroll: true });
      try { current.setSelectionRange(selectionStart ?? current.value.length, selectionEnd ?? current.value.length); } catch {}
      voiceChat.refocusTextAfterTurn = false;
    });
  }
  const log = $("#voice-chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

export function renderBrowserCoachStatus() {
  const stateNode = $("#settings-browser-coach-state");
  const messageNode = $("#settings-browser-coach-message");
  const actionNode = $("#settings-browser-coach-action");
  if (!stateNode || !messageNode) return;
  if (actionNode) actionNode.textContent = browserCoachAction || "";
  if (browserCoachChecking) {
    stateNode.textContent = "Checking";
    messageNode.textContent = "Checking the browser helper…";
    messageNode.classList.remove("is-error");
    return;
  }
  if (!browserCoachStatus) {
    stateNode.textContent = "Not connected";
    messageNode.textContent = "Helper not connected. See Setup below.";
    messageNode.classList.remove("is-error");
    return;
  }
  if (browserCoachStatus.available) {
    if (browserCoachStatus.expectedExtensionVersion && browserCoachStatus.extensionVersion && browserCoachStatus.expectedExtensionVersion !== browserCoachStatus.extensionVersion) {
      stateNode.textContent = "Update";
      messageNode.textContent = `Helper update ready (${browserCoachStatus.extensionVersion} → ${browserCoachStatus.expectedExtensionVersion}). Open this browser's Extensions page and press Reload.`;
      messageNode.classList.add("is-error");
      return;
    }
    stateNode.textContent = "Ready";
    const version = browserCoachStatus.extensionVersion ? ` (helper ${browserCoachStatus.extensionVersion})` : "";
    messageNode.textContent = `Coach ready${version}`;
    messageNode.classList.remove("is-error");
    return;
  }
  stateNode.textContent = "Offline";
  messageNode.textContent = browserCoachStatus.error || "Language Coach browser extension is not connected yet.";
  messageNode.classList.add("is-error");
}
