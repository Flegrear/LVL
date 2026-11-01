// Learning: the voice coach (providers, live sessions, voice turns and usage).
import crypto from "node:crypto";
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import {
  buildLiveTranscriptEnrichmentPrompt, buildNativeLiveVoicePrompt, buildVoiceCoachPrompt,
  buildVoiceCoachRepairPrompt, COACH_LIVE_IDLE_TIMEOUT_MS, coachLiveSessionKey,
  coachOutputMissingRequiredFields, isReusableCoachLiveSession, normalizeCoachAssistanceMode,
  normalizeCoachLivePreset, normalizeCoachTurnInput, normalizeCoachTurnOutput,
} from "../../learning/coach-core.js";
import { appDatabase, COACH_PROVIDERS, DEFAULT_COACH_PROVIDER_ID, voiceCoachSessions } from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "../app/http-helpers.js";
import { browserCoachDecision, validBrowserCoachInstanceId } from "./browser-coach.js";

const VOICE_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const VOICE_USAGE_REFERENCE_LIMIT_MS = 3 * 60 * 60 * 1000;
const VOICE_USAGE_ACTIVE_STALE_MS = 2 * 60 * 1000;

export function coachUsagePayload(now = Date.now()) {
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  if (usage.active && now - Number(usage.active.updatedAt || usage.active.startedAt || 0) > VOICE_USAGE_ACTIVE_STALE_MS) {
    const confirmedEndAt = Math.max(Number(usage.active.startedAt) || 0, Number(usage.active.updatedAt) || 0);
    if (confirmedEndAt > Number(usage.active.startedAt || 0)) {
      usage.segments = [...(Array.isArray(usage.segments) ? usage.segments : []), {
        startAt: Number(usage.active.startedAt),
        endAt: confirmedEndAt,
      }];
    }
    usage.active = null;
    appDatabase.writeSection("coachUsage", usage);
  }
  const windowStart = now - VOICE_USAGE_WINDOW_MS;
  const completedMs = (Array.isArray(usage.segments) ? usage.segments : []).reduce((total, segment) => {
    const startAt = Math.max(Number(segment?.startAt) || 0, windowStart);
    const endAt = Math.min(Number(segment?.endAt) || 0, now);
    return endAt > startAt ? total + (endAt - startAt) : total;
  }, 0);
  const activeStart = usage.active?.startedAt ? Math.max(Number(usage.active.startedAt) || 0, windowStart) : 0;
  const activeMs = activeStart > 0 && now > activeStart ? now - activeStart : 0;
  const usedMs = Math.max(0, completedMs + activeMs);
  return {
    windowMs: VOICE_USAGE_WINDOW_MS,
    limitMs: VOICE_USAGE_REFERENCE_LIMIT_MS,
    usedMs,
    remainingMs: Math.max(0, VOICE_USAGE_REFERENCE_LIMIT_MS - usedMs),
    active: usage.active || null,
    asOf: now,
  };
}

export async function coachUsageEndpoint(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  json(res, 200, coachUsagePayload());
  return true;
}

export function cleanVoiceCoachSessions() {
  const cutoff = Date.now() - COACH_LIVE_IDLE_TIMEOUT_MS;
  let changed = false;
  for (const [id, session] of voiceCoachSessions) {
    if (Number(session.updatedAt || 0) <= cutoff) {
      voiceCoachSessions.delete(id);
      changed = true;
    }
  }
  while (voiceCoachSessions.size > 24) {
    const oldest = [...voiceCoachSessions.entries()].sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))[0]?.[0];
    if (!oldest) break;
    voiceCoachSessions.delete(oldest);
    changed = true;
  }
  return changed;
}

export function persistVoiceCoachSessions() {
  appDatabase.writeSection("coachSessions", [...voiceCoachSessions.values()].map((session) => ({
    chatId: session.chatId,
    mode: "live",
    providerId: session.providerId,
    providerInstanceId: session.providerInstanceId || "",
    conversationId: session.conversationId || null,
    targetLanguage: session.targetLanguage || "EN",
    baseLanguage: session.baseLanguage || "EN",
    targetLocale: normalizeLearningLocale(session.targetLanguage, session.targetLocale),
    baseLocale: normalizeLearningLocale(session.baseLanguage, session.baseLocale),
    liveSeeded: Boolean(session.liveSeeded),
    nativeVoice: Boolean(session.nativeVoice),
    presetId: session.presetId || "",
    presetLabel: session.presetLabel || "",
    presetContext: session.presetContext || "",
    assistanceMode: normalizeCoachAssistanceMode(session.assistanceMode),
    updatedAt: Number(session.updatedAt) || Date.now(),
  })));
}

function coachProviderPublic(provider) {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    model: provider.model,
    transport: provider.transport,
    enabled: Boolean(provider.enabled),
    supports: { ...provider.supports },
  };
}

export async function coachProvidersEndpoint(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  json(res, 200, {
    defaultProviderId: DEFAULT_COACH_PROVIDER_ID,
    idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS,
    providers: [...COACH_PROVIDERS.values()].map(coachProviderPublic),
  });
  return true;
}

export async function coachLiveSessionStartEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : crypto.randomUUID();
  const providerId = String(body.providerId || DEFAULT_COACH_PROVIDER_ID).trim().slice(0, 80) || DEFAULT_COACH_PROVIDER_ID;
  const provider = COACH_PROVIDERS.get(providerId);
  if (!provider || !provider.enabled || !provider.supports?.liveVoice) {
    throw Object.assign(new Error(`Coach provider ${providerId} does not support native live voice.`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Native live voice is not implemented for ${provider.id} yet.`), { statusCode: 501 });
  }
  const providerInstanceId = validBrowserCoachInstanceId(body.providerInstanceId) ? body.providerInstanceId : "";
  const targetLanguage = String(body.targetLanguage || "EN").toUpperCase().slice(0, 8);
  const baseLanguage = String(body.baseLanguage || "EN").toUpperCase().slice(0, 8);
  const requestedAssistanceMode = normalizeCoachAssistanceMode(body.assistanceMode);
  const targetLocale = normalizeLearningLocale(targetLanguage, body.targetLocale);
  const baseLocale = normalizeLearningLocale(baseLanguage, body.baseLocale);
  const requestedPreset = normalizeCoachLivePreset(body);
  cleanVoiceCoachSessions();
  const sessionKey = coachLiveSessionKey(chatId, true);
  const previous = voiceCoachSessions.get(sessionKey);
  const reusable = isReusableCoachLiveSession({
    session: previous,
    nativeVoice: true,
    providerId: provider.id,
    providerInstanceId,
    targetLanguage,
    baseLanguage,
    assistanceMode: requestedAssistanceMode,
    targetLocale,
    baseLocale,
  });
  let conversationId = reusable ? previous.conversationId : null;
  const sessionAssistanceMode = reusable
    ? normalizeCoachAssistanceMode(previous.assistanceMode)
    : requestedAssistanceMode;
  let sessionPreset = reusable
    ? {
        presetId: previous.presetId || "",
        presetLabel: previous.presetLabel || "",
        presetContext: previous.presetContext || "",
      }
    : requestedPreset;
  if (!conversationId) {
    const prompt = buildNativeLiveVoicePrompt({
      targetLanguage,
      baseLanguage,
      targetLocale,
      baseLocale,
      assistanceMode: sessionAssistanceMode,
      ...requestedPreset,
    });
    const result = await browserCoachDecision(prompt, null, "text", providerInstanceId || null);
    conversationId = result.conversationId || null;
    if (!conversationId) throw Object.assign(new Error("ChatGPT did not create a live coach conversation."), { statusCode: 503 });
    sessionPreset = requestedPreset;
  }
  voiceCoachSessions.set(sessionKey, {
    chatId,
    mode: "live",
    providerId: provider.id,
    providerInstanceId,
    conversationId,
    targetLanguage,
    baseLanguage,
    liveSeeded: true,
    nativeVoice: true,
    assistanceMode: sessionAssistanceMode,
    targetLocale,
    baseLocale,
    ...sessionPreset,
    updatedAt: Date.now(),
  });
  cleanVoiceCoachSessions();
  persistVoiceCoachSessions();
  json(res, 200, {
    chatId,
    mode: "live",
    idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS,
    provider: coachProviderPublic(provider),
    session: { conversationId, reused: reusable, assistanceMode: sessionAssistanceMode },
  });
  return true;
}

export async function coachLiveSessionCloseEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  if (!chatId) throw Object.assign(new Error("A valid live coach chatId is required."), { statusCode: 400 });
  const providerId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
  const providerInstanceId = typeof body.providerInstanceId === "string" ? body.providerInstanceId.trim().slice(0, 120) : "";
  const nativeVoiceFilter = typeof body.nativeVoice === "boolean" ? body.nativeVoice : null;
  cleanVoiceCoachSessions();
  let closed = false;
  for (const [key, session] of voiceCoachSessions) {
    if (session.chatId !== chatId) continue;
    if (providerId && session.providerId !== providerId) continue;
    if (providerInstanceId && String(session.providerInstanceId || "") !== providerInstanceId) continue;
    if (nativeVoiceFilter !== null && Boolean(session.nativeVoice) !== nativeVoiceFilter) continue;
    voiceCoachSessions.delete(key);
    closed = true;
  }
  persistVoiceCoachSessions();
  json(res, 200, { ok: true, chatId, closed });
  return true;
}

export async function coachLiveSessionTouchEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  if (!chatId) throw Object.assign(new Error("A valid live coach chatId is required."), { statusCode: 400 });
  if (body.nativeVoice !== true) {
    throw Object.assign(new Error("Live session touch requires nativeVoice: true."), { statusCode: 400 });
  }
  const providerId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
  const providerInstanceId = typeof body.providerInstanceId === "string" ? body.providerInstanceId.trim().slice(0, 120) : "";
  const cleaned = cleanVoiceCoachSessions();
  const now = Date.now();
  let touched = false;
  for (const session of voiceCoachSessions.values()) {
    if (session.chatId !== chatId || session.mode !== "live" || session.nativeVoice !== true) continue;
    if (providerId && session.providerId !== providerId) continue;
    if (providerInstanceId && String(session.providerInstanceId || "") !== providerInstanceId) continue;
    session.updatedAt = now;
    touched = true;
  }
  if (cleaned || touched) persistVoiceCoachSessions();
  json(res, 200, { ok: true, touched, idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS });
  return true;
}

export async function coachLiveTranscriptEnrichEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const providerId = String(body.providerId || DEFAULT_COACH_PROVIDER_ID).trim().slice(0, 80) || DEFAULT_COACH_PROVIDER_ID;
  const provider = COACH_PROVIDERS.get(providerId);
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error(`Unknown or unavailable coach provider: ${providerId}`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Transcript enrichment is not implemented for ${provider.id} yet.`), { statusCode: 501 });
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 40).map((item) => ({
    id: String(item?.id || "").slice(0, 200),
    text: String(item?.text || "").slice(0, 4000),
  })).filter((item) => item.id && item.text) : [];
  if (!items.length) throw Object.assign(new Error("No live transcript items were supplied."), { statusCode: 400 });
  const targetLanguage = String(body.targetLanguage || "EN").toUpperCase().slice(0, 8);
  const baseLanguage = String(body.baseLanguage || "EN").toUpperCase().slice(0, 8);
  const providerInstanceId = validBrowserCoachInstanceId(body.providerInstanceId) ? body.providerInstanceId : null;
  const prompt = buildLiveTranscriptEnrichmentPrompt({ targetLanguage, baseLanguage, items });
  const result = await browserCoachDecision(prompt, null, "text", providerInstanceId);
  const raw = String(result.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    throw Object.assign(new Error("The coach provider returned invalid transcript enrichment JSON."), { statusCode: 503 });
  }
  const allowedIds = new Set(items.map((item) => item.id));
  const enriched = (Array.isArray(parsed?.items) ? parsed.items : []).slice(0, 40).map((item) => ({
    id: String(item?.id || "").slice(0, 200),
    targetText: String(item?.targetText || "").slice(0, 4000),
    romanized: String(item?.romanized || "").slice(0, 4000),
    baseText: String(item?.baseText || "").slice(0, 4000),
  })).filter((item) => allowedIds.has(item.id));
  json(res, 200, { provider: coachProviderPublic(provider), items: enriched });
  return true;
}

async function runCoachProvider(turn, previous = null) {
  const provider = COACH_PROVIDERS.get(turn.providerId);
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error(`Unknown or unavailable coach provider: ${turn.providerId}`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Coach provider ${provider.id} is not implemented yet.`), { statusCode: 501 });
  }
  const continuingLiveSession = turn.mode === "live" && isReusableCoachLiveSession({
    session: previous,
    nativeVoice: false,
    providerId: provider.id,
    providerInstanceId: turn.providerInstanceId || "",
    targetLanguage: turn.languages.target,
    baseLanguage: turn.languages.base,
    targetLocale: turn.locales.target,
    baseLocale: turn.locales.base,
  });
  const prompt = buildVoiceCoachPrompt(turn, { continuation: continuingLiveSession });
  const conversationId = continuingLiveSession ? previous.conversationId : null;
  let result = await browserCoachDecision(prompt, conversationId || null, "voice-json", turn.providerInstanceId || null);
  let normalized = normalizeCoachTurnOutput({
    turn,
    provider,
    rawText: result.text,
    conversationId: result.conversationId || conversationId || null,
    transport: result.transport || provider.transport,
    continued: continuingLiveSession,
  });
  if (turn.mode === "practice" && coachOutputMissingRequiredFields(turn, normalized.output)) {
    const repairPrompt = buildVoiceCoachRepairPrompt(turn, result.text);
    const repair = await browserCoachDecision(
      repairPrompt,
      result.conversationId || conversationId || null,
      "voice-json",
      turn.providerInstanceId || null,
    );
    result = repair;
    normalized = normalizeCoachTurnOutput({
      turn,
      provider,
      rawText: repair.text,
      conversationId: repair.conversationId || conversationId || null,
      transport: repair.transport || provider.transport,
      continued: true,
    });
    if (coachOutputMissingRequiredFields(turn, normalized.output)) {
      throw Object.assign(new Error("The coach response was missing required target, romaji, or base-language fields after one repair attempt."), { statusCode: 502 });
    }
  }
  return normalized;
}

async function processCoachVoiceTurn(body) {
  const turn = normalizeCoachTurnInput(body, DEFAULT_COACH_PROVIDER_ID);
  if (!turn.chatId) turn.chatId = crypto.randomUUID();
  if (!turn.input.transcript) throw Object.assign(new Error("No learner input transcript was provided."), { statusCode: 400 });
  cleanVoiceCoachSessions();
  const sessionKey = coachLiveSessionKey(turn.chatId, false);
  const previous = turn.mode === "live" ? voiceCoachSessions.get(sessionKey) : null;
  const normalized = await runCoachProvider(turn, previous);
  if (turn.mode === "live") {
    voiceCoachSessions.set(sessionKey, {
      chatId: turn.chatId,
      mode: "live",
      providerId: normalized.provider.id,
      providerInstanceId: turn.providerInstanceId || "",
      conversationId: normalized.session.conversationId || null,
      targetLanguage: turn.languages.target,
      baseLanguage: turn.languages.base,
      targetLocale: turn.locales.target,
      baseLocale: turn.locales.base,
      liveSeeded: true,
      nativeVoice: false,
      updatedAt: Date.now(),
    });
    cleanVoiceCoachSessions();
    persistVoiceCoachSessions();
  }
  return normalized;
}

export async function coachVoiceTurnEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const normalized = await processCoachVoiceTurn(await readJsonBody(req));
  json(res, 200, normalized);
  return true;
}

export async function browserVoiceCorrection(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const normalized = await processCoachVoiceTurn(await readJsonBody(req));
  // Compatibility response for older app builds. New clients should use /api/coach/voice-turn.
  json(res, 200, {
    chatId: normalized.chatId,
    ...normalized.output,
    provider: normalized.provider,
    transport: normalized.provider.transport,
    acousticScoring: normalized.capabilities.acousticScoring,
  });
  return true;
}
