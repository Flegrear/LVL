// Learning: the browser coach extension (pairing, polling, results and live control).
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as crypto } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appDatabase, BROWSER_COACH_EXTENSION_DIR, browserCoachToken, DEFAULT_COACH_PROVIDER_ID,
  voiceCoachSessions,
} from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "../app/http-helpers.js";
import { cleanVoiceCoachSessions, coachUsagePayload, persistVoiceCoachSessions } from "./voice-coach.js";

const BROWSER_COACH_CLIENT = "language-video-learner-browser-extension";
const BROWSER_COACH_REQUEST_TIMEOUT_MS = 125 * 1000;
// MV3 service workers are intentionally allowed to sleep when the helper tab has not
// been created yet. Our fallback alarm wakes the extension roughly every 30 seconds,
// so a 12-second presence window incorrectly flaps the UI to OFFLINE while the
// extension is healthy but idle. Keep enough margin to tolerate one delayed alarm.
const BROWSER_COACH_PRESENCE_MS = 75 * 1000;

// The helper is deliberately absent from the media-only Alpha. Retain its
// last protocol version for legacy route/test compatibility until Learning
// and its separately reviewed extension return.
const BROWSER_COACH_EXTENSION_VERSION = "0.1.30";

const browserCoachRequests = new Map();

let browserCoachExtension = { lastSeenAt: 0, version: null, origin: null };
const browserCoachInstances = new Map();

export function validBrowserCoachInstanceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value);
}

function browserCoachVersionCompatible(version) {
  return !BROWSER_COACH_EXTENSION_VERSION || String(version || "") === BROWSER_COACH_EXTENSION_VERSION;
}

function rejectBrowserCoachVersionMismatch(res, version) {
  if (browserCoachVersionCompatible(version)) return false;
  json(res, 426, {
    error: "extension_version_mismatch",
    message: `Reload the Language Coach extension. Expected ${BROWSER_COACH_EXTENSION_VERSION}, received ${String(version || "unknown")}.`,
    expectedExtensionVersion: BROWSER_COACH_EXTENSION_VERSION,
    extensionVersion: String(version || "") || null,
  });
  return true;
}

function browserCoachInstanceCompatible(instanceId = null) {
  if (validBrowserCoachInstanceId(instanceId)) {
    const instance = browserCoachInstances.get(instanceId);
    return Boolean(instance && browserCoachVersionCompatible(instance.version));
  }
  if ([...browserCoachInstances.values()].some((instance) =>
    Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS && browserCoachVersionCompatible(instance?.version))) return true;
  return browserCoachVersionCompatible(browserCoachExtension.version);
}

function browserCoachPresent(instanceId = null) {
  if (validBrowserCoachInstanceId(instanceId)) {
    const instance = browserCoachInstances.get(instanceId);
    return Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS;
  }
  if ([...browserCoachInstances.values()].some((instance) => Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS)) return true;
  return Date.now() - Number(browserCoachExtension.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS;
}

function browserCoachAuthorised(req) {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  return auth === `Bearer ${browserCoachToken}`;
}

function touchBrowserCoach(req, version = null, instanceId = null) {
  browserCoachExtension.lastSeenAt = Date.now();
  browserCoachExtension.version = version || browserCoachExtension.version;
  browserCoachExtension.origin = typeof req.headers.origin === "string" ? req.headers.origin : browserCoachExtension.origin;
  if (validBrowserCoachInstanceId(instanceId)) {
    const previous = browserCoachInstances.get(instanceId) || {};
    browserCoachInstances.set(instanceId, {
      lastSeenAt: Date.now(),
      version: version || previous.version || null,
      origin: typeof req.headers.origin === "string" ? req.headers.origin : previous.origin || null,
    });
  }
}

function cleanBrowserCoachRequests() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, request] of browserCoachRequests) {
    if (request.createdAt < cutoff) {
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("The browser coach request expired."), { statusCode: 504 }));
      browserCoachRequests.delete(id);
    }
  }
}

export async function browserCoachPair(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && !origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://")) {
    json(res, 403, { error: "Browser extension pairing is only available to extension contexts." });
    return true;
  }
  const body = await readJsonBody(req);
  if (body.client !== BROWSER_COACH_CLIENT) {
    json(res, 403, { error: "Unknown browser coach client." });
    return true;
  }
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  json(res, 200, { token: browserCoachToken, heartbeatMs: 2000, protocol: 1, instanceId });
  return true;
}

export async function browserCoachPoll(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  cleanBrowserCoachRequests();
  const now = Date.now();
  const next = [...browserCoachRequests.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .find((entry) => (!entry.instanceId || entry.instanceId === instanceId) && (!entry.claimedAt || now - entry.claimedAt > 15_000));
  if (!next) {
    json(res, 200, { request: null });
    return true;
  }
  next.claimedAt = now;
  next.attempts += 1;
  json(res, 200, {
    request: {
      id: next.id,
      prompt: next.prompt,
      conversationId: next.conversationId,
      completionMode: next.completionMode,
      attempt: next.attempts,
    },
  });
  return true;
}

export async function browserCoachResult(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const id = typeof body.id === "string" ? body.id : "";
  const pending = browserCoachRequests.get(id);
  if (!pending) {
    json(res, 404, { error: "request_not_found" });
    return true;
  }
  if (pending.instanceId && pending.instanceId !== instanceId) {
    json(res, 409, { error: "wrong_browser_instance" });
    return true;
  }
  browserCoachRequests.delete(id);
  clearTimeout(pending.timer);
  if (body.error) {
    pending.reject(Object.assign(new Error(String(body.error).slice(0, 1000)), { statusCode: 503 }));
    json(res, 200, { ok: true });
    return true;
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 16_000) : "";
  if (!text) {
    pending.reject(Object.assign(new Error("The ChatGPT browser helper returned an empty response."), { statusCode: 503 }));
    json(res, 200, { ok: true });
    return true;
  }
  pending.resolve({
    text,
    conversationId: typeof body.conversationId === "string" ? body.conversationId.slice(0, 200) : null,
  });
  json(res, 200, { ok: true });
  return true;
}

export async function browserCoachLiveTranscript(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  const conversationId = typeof body.conversationId === "string" && /^[0-9a-f-]{8,64}$/i.test(body.conversationId)
    ? body.conversationId
    : null;
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20).map((entry) => ({
    id: String(entry?.id || "").slice(0, 200),
    role: entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "",
    text: String(entry?.text || "").trim().slice(0, 4000),
  })).filter((entry) => entry.id && entry.role && entry.text) : [];
  if (!chatId || !conversationId || !entries.length) {
    json(res, 400, { error: "A valid live transcript batch is required." });
    return true;
  }

  cleanVoiceCoachSessions();
  const session = [...voiceCoachSessions.values()].find((candidate) =>
    candidate?.chatId === chatId && candidate?.nativeVoice === true && candidate?.conversationId === conversationId,
  );
  if (!session) {
    json(res, 409, { error: "live_session_not_found" });
    return true;
  }
  if (session.providerInstanceId && instanceId && session.providerInstanceId !== instanceId) {
    json(res, 409, { error: "wrong_browser_instance" });
    return true;
  }
  if (!session.providerInstanceId && instanceId) session.providerInstanceId = instanceId;

  const now = Date.now();
  session.updatedAt = now;
  persistVoiceCoachSessions();
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  if (usage.active?.chatId === chatId && usage.active?.conversationId === conversationId) {
    usage.active.updatedAt = now;
    appDatabase.writeSection("coachUsage", usage);
  }
  const transcripts = appDatabase.readSection("coachTranscripts") || [];
  const previous = transcripts.find((transcript) => transcript?.id === chatId) || null;
  const incomingMessages = entries.map((entry, index) => ({
    role: entry.role,
    mode: "live",
    text: entry.text,
    targetText: entry.role === "assistant" ? entry.text : "",
    romanized: "",
    baseText: "",
    providerEntryId: entry.id,
    createdAt: now + index,
  }));
  const nextTranscript = {
    ...(previous || {}),
    id: chatId,
    mode: "live",
    providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
    providerInstanceId: session.providerInstanceId || instanceId || "",
    conversationId,
    targetLanguage: session.targetLanguage || previous?.targetLanguage || "EN",
    baseLanguage: session.baseLanguage || previous?.baseLanguage || "EN",
    presetId: session.presetId || previous?.presetId || "",
    presetLabel: session.presetLabel || previous?.presetLabel || "",
    messages: [...(Array.isArray(previous?.messages) ? previous.messages : []), ...incomingMessages],
    updatedAt: now,
  };
  appDatabase.writeSection("coachTranscripts", [
    ...transcripts.filter((transcript) => transcript?.id !== chatId),
    nextTranscript,
  ]);
  json(res, 200, { ok: true, persisted: entries.length, chatId, conversationId });
  return true;
}

export async function browserCoachLiveControl(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const action = body.action === "start" ? "start" : body.action === "stop" ? "stop" : body.action === "touch" ? "touch" : "";
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId) ? body.chatId : null;
  const conversationId = typeof body.conversationId === "string" && /^[0-9a-f-]{8,64}$/i.test(body.conversationId)
    ? body.conversationId
    : null;
  if (!action || !chatId || !conversationId) {
    json(res, 400, { error: "A valid Live Voice control event is required." });
    return true;
  }

  const now = Date.now();
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  const segments = Array.isArray(usage.segments) ? [...usage.segments] : [];
  let active = usage.active || null;
  if (action === "start" || action === "touch") {
    cleanVoiceCoachSessions();
    const session = [...voiceCoachSessions.values()].find((candidate) =>
      candidate?.chatId === chatId && candidate?.nativeVoice === true && candidate?.conversationId === conversationId,
    );
    if (!session) {
      json(res, 409, { error: "live_session_not_found" });
      return true;
    }
    if (session.providerInstanceId && instanceId && session.providerInstanceId !== instanceId) {
      json(res, 409, { error: "wrong_browser_instance" });
      return true;
    }
    if (!session.providerInstanceId && instanceId) session.providerInstanceId = instanceId;
    session.updatedAt = now;
    persistVoiceCoachSessions();
    if (action === "start" && active && (active.chatId !== chatId || active.conversationId !== conversationId)) {
      const previousStart = Number(active.startedAt) || 0;
      if (previousStart > 0 && now > previousStart) segments.push({ startAt: previousStart, endAt: now });
      active = null;
    }
    if (!active && action === "start") {
      active = {
        chatId,
        conversationId,
        providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
        providerInstanceId: session.providerInstanceId || instanceId || "",
        startedAt: now,
        updatedAt: now,
      };
    } else if (active?.chatId === chatId && active?.conversationId === conversationId) {
      active.updatedAt = now;
    } else if (action === "touch") {
      // A confirmed provider heartbeat after an app/server reload can arrive before the
      // local app replays its start state. Resume accounting from this confirmation rather
      // than leaving the timer permanently inactive.
      active = {
        chatId,
        conversationId,
        providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
        providerInstanceId: session.providerInstanceId || instanceId || "",
        startedAt: now,
        updatedAt: now,
      };
    }
  } else if (active?.chatId === chatId && active?.conversationId === conversationId) {
    const startedAt = Number(active.startedAt) || 0;
    if (startedAt > 0 && now > startedAt) segments.push({ startAt: startedAt, endAt: now });
    active = null;
  }
  appDatabase.writeSection("coachUsage", { segments, active });
  json(res, 200, { ok: true, action, usage: coachUsagePayload(now) });
  return true;
}

export async function browserCoachStatus(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const requestedInstanceId = validBrowserCoachInstanceId(url.searchParams.get("instanceId")) ? url.searchParams.get("instanceId") : null;
  const instance = requestedInstanceId ? browserCoachInstances.get(requestedInstanceId) : null;
  const activeInstances = [...browserCoachInstances.entries()]
    .filter(([, entry]) => Date.now() - Number(entry?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS)
    .map(([instanceId, entry]) => ({
      instanceId,
      version: entry?.version || null,
      lastSeenAt: entry?.lastSeenAt || null,
    }));
  json(res, 200, {
    available: browserCoachPresent(requestedInstanceId),
    extensionVersion: instance?.version || browserCoachExtension.version,
    expectedExtensionVersion: BROWSER_COACH_EXTENSION_VERSION || null,
    lastSeenAt: instance?.lastSeenAt || browserCoachExtension.lastSeenAt || null,
    instanceId: requestedInstanceId,
    activeInstances,
    extensionPath: BROWSER_COACH_EXTENSION_DIR,
    transport: "signed-in-chatgpt-browser",
    authMode: "existing-browser-session",
    credentialsRequired: [],
  });
  return true;
}

export async function openBrowserCoachExtensionFolder(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!fs.existsSync(BROWSER_COACH_EXTENSION_DIR)) {
    throw Object.assign(new Error("The browser coach extension has not been built yet."), { statusCode: 503 });
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [BROWSER_COACH_EXTENSION_DIR], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  let extensionsPageOpened = false;
  if (process.platform === "win32") {
    const requested = ["edge", "chrome", "brave"].includes(body.browser) ? body.browser : null;
    const candidates = requested === "edge"
      ? [
          path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : requested === "chrome"
        ? [
            path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : requested === "brave"
          ? [
              path.join(process.env.ProgramFiles || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
              path.join(process.env["ProgramFiles(x86)"] || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
              path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            ]
        : [];
    const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (executable) {
      const url = requested === "edge" ? "edge://extensions/" : requested === "brave" ? "brave://extensions/" : "chrome://extensions/";
      const browser = spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: false });
      browser.unref();
      extensionsPageOpened = true;
    }
  }
  json(res, 200, { opened: true, extensionsPageOpened, path: BROWSER_COACH_EXTENSION_DIR });
  return true;
}

async function extensionBrowserCoachDecision(prompt, conversationId = null, completionMode = "text", instanceId = null) {
  if (browserCoachPresent(instanceId) && !browserCoachInstanceCompatible(instanceId)) {
    throw Object.assign(new Error(`Language Coach extension version mismatch. Reload the unpacked extension; expected ${BROWSER_COACH_EXTENSION_VERSION}.`), { statusCode: 426 });
  }
  if (!browserCoachPresent(instanceId)) {
    // After a local server restart the MV3 worker can still be asleep until its next
    // scheduled wake-up. Give it a short grace period to re-pair instead of rejecting
    // the learner's first turn even though the extension is installed and healthy.
    const wakeDeadline = Date.now() + 35_000;
    while (!browserCoachPresent(instanceId) && Date.now() < wakeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!browserCoachPresent(instanceId)) {
      throw Object.assign(new Error("Language Coach browser extension is not connected in this app browser. Load the extension in the same browser that is running the app and keep ChatGPT signed in there."), { statusCode: 503 });
    }
  }
  if (!browserCoachInstanceCompatible(instanceId)) {
    throw Object.assign(new Error(`Language Coach extension version mismatch. Reload the unpacked extension; expected ${BROWSER_COACH_EXTENSION_VERSION}.`), { statusCode: 426 });
  }
  cleanBrowserCoachRequests();
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browserCoachRequests.delete(id);
      reject(Object.assign(new Error("ChatGPT browser helper timed out."), { statusCode: 504 }));
    }, BROWSER_COACH_REQUEST_TIMEOUT_MS);
    browserCoachRequests.set(id, {
      id,
      prompt: String(prompt || "").slice(0, 16_000),
      conversationId: typeof conversationId === "string" ? conversationId.slice(0, 200) : null,
      completionMode: completionMode === "voice-json" ? "voice-json" : "text",
      instanceId: validBrowserCoachInstanceId(instanceId) ? instanceId : null,
      createdAt: Date.now(),
      claimedAt: 0,
      attempts: 0,
      timer,
      resolve,
      reject,
    });
  });
}

export async function browserCoachDecision(prompt, conversationId = null, completionMode = "text", instanceId = null) {
  const result = await extensionBrowserCoachDecision(prompt, conversationId, completionMode, instanceId);
  return { ...result, transport: "signed-in-chatgpt-browser" };
}

export async function browserCoachDecisionEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const prompt = String(body.prompt || "").trim().slice(0, 16_000);
  if (!prompt) throw Object.assign(new Error("The language-coach prompt is empty."), { statusCode: 400 });
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.slice(0, 200) : null;
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const result = await browserCoachDecision(prompt, conversationId, "text", instanceId);
  json(res, 200, result);
  return true;
}
