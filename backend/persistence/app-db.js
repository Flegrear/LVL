import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";

export const APP_STATE_SCHEMA_VERSION = 3;
export const APP_STATE_SECTIONS = Object.freeze([
  "cards",
  "known",
  "library",
  "learningExposure",
  "testResults",
  "preferences",
  "coachSessions",
  "coachTranscripts",
  "coachUsage",
]);

const CORE_SECTIONS = new Set(["cards", "known", "library", "learningExposure", "testResults"]);

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function safeArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergePreferenceDefaults(existing, incoming) {
  const current = safeObject(existing);
  const fallback = safeObject(incoming);
  const merged = { ...fallback, ...current };
  for (const key of new Set([...Object.keys(fallback), ...Object.keys(current)])) {
    const currentValue = current[key];
    const fallbackValue = fallback[key];
    if (safeObject(currentValue) === currentValue || safeObject(fallbackValue) === fallbackValue) {
      const currentObject = safeObject(currentValue);
      const fallbackObject = safeObject(fallbackValue);
      if (Object.keys(currentObject).length || Object.keys(fallbackObject).length) {
        merged[key] = mergePreferenceDefaults(currentObject, fallbackObject);
      }
    }
  }
  return merged;
}

function cardProgressScore(card) {
  return [
    Math.max(0, Number(card?.reviewCount) || 0),
    Math.max(0, Number(card?.lapses) || 0),
    Math.max(0, Number(card?.updatedAt) || 0),
    Math.max(0, Number(card?.dueAt) || 0),
    Math.max(0, Number(card?.createdAt) || 0),
  ];
}

function lexicographicallyGreater(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = Number(a[index]) || 0;
    const right = Number(b[index]) || 0;
    if (left !== right) return left > right;
  }
  return false;
}

function mergeCards(existing, incoming) {
  const byId = new Map();
  for (const card of [...safeArray(existing, 20_000), ...safeArray(incoming, 20_000)]) {
    if (!card || typeof card !== "object") continue;
    const id = String(card.id || "").slice(0, 200);
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || lexicographicallyGreater(cardProgressScore(card), cardProgressScore(previous))) byId.set(id, card);
  }
  return [...byId.values()].slice(0, 20_000);
}

function mergeLibrary(existing, incoming) {
  const byId = new Map();
  for (const entry of [...safeArray(existing, 5_000), ...safeArray(incoming, 5_000)]) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id || "").slice(0, 400);
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || Number(entry.updatedAt || entry.addedAt || 0) >= Number(previous.updatedAt || previous.addedAt || 0)) byId.set(id, entry);
  }
  return [...byId.values()].slice(0, 5_000);
}

function mergeKnown(existing, incoming) {
  return [...new Set([...safeArray(existing, 100_000), ...safeArray(incoming, 100_000)].map(String).filter(Boolean))].slice(0, 100_000);
}

function mergeExposure(existing, incoming) {
  const result = { ...safeObject(existing) };
  for (const [key, raw] of Object.entries(safeObject(incoming)).slice(0, 12_000)) {
    const next = safeObject(raw);
    const previous = safeObject(result[key]);
    const nextSeen = Number(next.lastSeenAt) || 0;
    const previousSeen = Number(previous.lastSeenAt) || 0;
    result[String(key).slice(0, 500)] = {
      encounters: Math.max(Number(previous.encounters) || 0, Number(next.encounters) || 0),
      media: Math.max(Number(previous.media) || 0, Number(next.media) || 0),
      lastMedia: String(nextSeen >= previousSeen ? next.lastMedia || "" : previous.lastMedia || "").slice(0, 1000),
      lastSeenAt: Math.max(previousSeen, nextSeen),
    };
  }
  const entries = Object.entries(result);
  if (entries.length <= 10_000) return result;
  entries.sort((a, b) => Number(b[1]?.lastSeenAt || 0) - Number(a[1]?.lastSeenAt || 0));
  return Object.fromEntries(entries.slice(0, 10_000));
}

function mergeTestResults(existing, incoming) {
  const byId = new Map();
  for (const result of [...safeArray(existing, 500), ...safeArray(incoming, 500)]) {
    if (!result || typeof result !== "object") continue;
    const id = String(result.id || "").slice(0, 200);
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || Number(result.completedAt || result.startedAt || 0) >= Number(previous.completedAt || previous.startedAt || 0)) byId.set(id, result);
  }
  return [...byId.values()]
    .sort((a, b) => Number(a.completedAt || a.startedAt || 0) - Number(b.completedAt || b.startedAt || 0))
    .slice(-500);
}

function normalizeCoachSession(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const chatId = String(raw.chatId || "").slice(0, 64);
  if (!/^[0-9a-f-]{20,64}$/i.test(chatId)) return null;
  const updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
  return {
    chatId,
    mode: "live",
    providerId: String(raw.providerId || "").trim().slice(0, 80),
    providerInstanceId: String(raw.providerInstanceId || "").trim().slice(0, 120),
    conversationId: raw.conversationId == null ? null : String(raw.conversationId).slice(0, 200),
    targetLanguage: String(raw.targetLanguage || "EN").toUpperCase().slice(0, 8),
    baseLanguage: String(raw.baseLanguage || "EN").toUpperCase().slice(0, 8),
    targetLocale: normalizeLearningLocale(raw.targetLanguage, raw.targetLocale),
    baseLocale: normalizeLearningLocale(raw.baseLanguage, raw.baseLocale),
    liveSeeded: Boolean(raw.liveSeeded),
    nativeVoice: Boolean(raw.nativeVoice),
    assistanceMode: raw.assistanceMode === "unassisted" ? "unassisted" : "assisted",
    presetId: String(raw.presetId || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 80),
    presetLabel: String(raw.presetLabel || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 160),
    presetContext: String(raw.presetContext || "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 2400)
      .trim(),
    updatedAt,
  };
}

function mergeCoachSessions(existing, incoming) {
  const bySession = new Map();
  for (const raw of [...safeArray(existing, 100), ...safeArray(incoming, 100)]) {
    const session = normalizeCoachSession(raw);
    if (!session) continue;
    const key = `${session.chatId}:${session.nativeVoice ? "native-voice" : "text-live"}`;
    const previous = bySession.get(key);
    if (!previous || session.updatedAt >= previous.updatedAt) bySession.set(key, session);
  }
  return [...bySession.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 24);
}

function normalizeCoachTranscript(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id || raw.chatId || "").slice(0, 64);
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) return null;
  const messages = mergeCoachTranscriptMessages([], safeArray(raw.messages, 200).map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) return null;
    return {
      role,
      text: String(message.text || "").slice(0, 4000),
      targetText: String(message.targetText || "").slice(0, 4000),
      romanized: String(message.romanized || "").slice(0, 4000),
      baseText: String(message.baseText || "").slice(0, 4000),
      providerEntryId: String(message.providerEntryId || "").slice(0, 200),
      corrections: safeArray(message.corrections, 6).map((item) => ({
        heard: String(item?.heard || "").slice(0, 240),
        better: String(item?.better || "").slice(0, 240),
        note: String(item?.note || "").slice(0, 500),
      })),
      pronunciation: safeArray(message.pronunciation, 6).map((item) => ({
        word: String(item?.word || "").slice(0, 120),
        tip: String(item?.tip || "").slice(0, 500),
      })),
      provider: message.provider && typeof message.provider === "object" && !Array.isArray(message.provider)
        ? {
            id: String(message.provider.id || "").slice(0, 80),
            label: String(message.provider.label || "").slice(0, 160),
            model: String(message.provider.model || "").slice(0, 120),
            transport: String(message.provider.transport || "").slice(0, 120),
          }
        : null,
      acousticScoring: Boolean(message.acousticScoring),
      mode: message.mode === "live" || message.mode === "practice"
        ? message.mode
        : raw.mode === "live" ? "live" : "practice",
      createdAt: Math.max(0, Number(message.createdAt) || 0),
    };
  }).filter(Boolean));
  return {
    id,
    mode: raw.mode === "practice" ? "practice" : "live",
    providerId: String(raw.providerId || "").trim().slice(0, 80),
    providerInstanceId: String(raw.providerInstanceId || "").trim().slice(0, 120),
    conversationId: raw.conversationId == null ? "" : String(raw.conversationId).slice(0, 200),
    targetLanguage: String(raw.targetLanguage || "EN").toUpperCase().slice(0, 8),
    baseLanguage: String(raw.baseLanguage || "EN").toUpperCase().slice(0, 8),
    presetId: String(raw.presetId || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 80),
    presetLabel: String(raw.presetLabel || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 160),
    messages,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

function coachTranscriptMessageKey(message) {
  const providerEntryId = String(message?.providerEntryId || "").trim();
  if (providerEntryId) return `provider:${providerEntryId}`;
  return `local:${message?.role || ""}:${Number(message?.createdAt) || 0}:${String(message?.text || "")}`;
}

function mergeCoachTranscriptMessages(existing, incoming) {
  const merged = [];
  const indexByKey = new Map();
  for (const message of [...safeArray(existing, 200), ...safeArray(incoming, 200)]) {
    if (!message || typeof message !== "object") continue;
    const key = coachTranscriptMessageKey(message);
    const previousIndex = indexByKey.get(key);
    if (previousIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({ ...message });
      continue;
    }
    const previous = merged[previousIndex];
    merged[previousIndex] = {
      ...previous,
      ...message,
      text: String(message.text || previous.text || ""),
      targetText: String(message.targetText || previous.targetText || ""),
      romanized: String(message.romanized || previous.romanized || ""),
      baseText: String(message.baseText || previous.baseText || ""),
      providerEntryId: String(message.providerEntryId || previous.providerEntryId || ""),
      corrections: Array.isArray(message.corrections) && message.corrections.length ? message.corrections : previous.corrections || [],
      pronunciation: Array.isArray(message.pronunciation) && message.pronunciation.length ? message.pronunciation : previous.pronunciation || [],
      provider: message.provider || previous.provider || null,
      acousticScoring: Boolean(message.acousticScoring || previous.acousticScoring),
      createdAt: Math.min(
        Number(previous.createdAt) || Number(message.createdAt) || 0,
        Number(message.createdAt) || Number(previous.createdAt) || 0,
      ),
    };
  }
  return merged.slice(-200);
}

function mergeCoachTranscripts(existing, incoming) {
  const byId = new Map();
  for (const raw of [...safeArray(existing, 100), ...safeArray(incoming, 100)]) {
    const transcript = normalizeCoachTranscript(raw);
    if (!transcript) continue;
    const previous = byId.get(transcript.id);
    if (!previous) {
      byId.set(transcript.id, transcript);
      continue;
    }
    const newer = transcript.updatedAt >= previous.updatedAt ? transcript : previous;
    const older = newer === transcript ? previous : transcript;
    byId.set(transcript.id, {
      ...older,
      ...newer,
      providerId: newer.providerId || older.providerId,
      providerInstanceId: newer.providerInstanceId || older.providerInstanceId,
      conversationId: newer.conversationId || older.conversationId,
      targetLanguage: newer.targetLanguage || older.targetLanguage,
      baseLanguage: newer.baseLanguage || older.baseLanguage,
      presetId: newer.presetId || older.presetId,
      presetLabel: newer.presetLabel || older.presetLabel,
      messages: mergeCoachTranscriptMessages(previous.messages, transcript.messages),
      updatedAt: Math.max(previous.updatedAt, transcript.updatedAt),
    });
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 100);
}

function normalizeCoachUsage(raw) {
  const source = safeObject(raw);
  const segments = safeArray(source.segments, 512).map((segment) => ({
    startAt: Math.max(0, Number(segment?.startAt) || 0),
    endAt: Math.max(0, Number(segment?.endAt) || 0),
  })).filter((segment) => segment.startAt > 0 && segment.endAt > segment.startAt)
    .sort((a, b) => a.startAt - b.startAt);
  const mergedSegments = [];
  for (const segment of segments) {
    const previous = mergedSegments.at(-1);
    if (previous && segment.startAt <= previous.endAt) {
      previous.endAt = Math.max(previous.endAt, segment.endAt);
    } else {
      mergedSegments.push({ ...segment });
    }
  }
  const activeRaw = safeObject(source.active);
  const activeChatId = String(activeRaw.chatId || "").slice(0, 64);
  const activeConversationId = String(activeRaw.conversationId || "").slice(0, 200);
  const activeStartedAt = Math.max(0, Number(activeRaw.startedAt) || 0);
  const active = /^[0-9a-f-]{20,64}$/i.test(activeChatId) && activeConversationId && activeStartedAt > 0
    ? {
        chatId: activeChatId,
        conversationId: activeConversationId,
        providerId: String(activeRaw.providerId || "").trim().slice(0, 80),
        providerInstanceId: String(activeRaw.providerInstanceId || "").trim().slice(0, 120),
        startedAt: activeStartedAt,
        updatedAt: Math.max(activeStartedAt, Number(activeRaw.updatedAt) || activeStartedAt),
      }
    : null;
  return { segments: mergedSegments.slice(-512), active };
}

function mergeCoachUsage(existing, incoming) {
  const left = normalizeCoachUsage(existing);
  const right = normalizeCoachUsage(incoming);
  const active = !left.active
    ? right.active
    : !right.active
      ? left.active
      : Number(right.active.updatedAt || 0) >= Number(left.active.updatedAt || 0) ? right.active : left.active;
  return normalizeCoachUsage({ segments: [...left.segments, ...right.segments], active });
}

export function createAppDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS app_state (
      section TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const readStatement = db.prepare("SELECT value_json, updated_at FROM app_state WHERE section = ?");
  const writeStatement = db.prepare(`
    INSERT INTO app_state(section, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  // SQLite serializes writers across processes. Keep the revision comparison,
  // revision assignment and value replacement inside ONE immediate transaction.
  // Checking sectionUpdatedAt() in an HTTP handler before a separate write can
  // otherwise allow two servers with the same database to accept stale edits.
  function writeTransaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const metaReadStatement = db.prepare("SELECT value FROM app_meta WHERE key = ?");
  const metaWriteStatement = db.prepare(`
    INSERT INTO app_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  metaWriteStatement.run("schema_version", String(APP_STATE_SCHEMA_VERSION));

  function readSection(section) {
    if (!APP_STATE_SECTIONS.includes(section)) return undefined;
    const row = readStatement.get(section);
    if (!row) return undefined;
    const fallback = ["cards", "known", "library", "testResults", "coachSessions", "coachTranscripts"].includes(section) ? [] : {};
    const value = parseJson(row.value_json, fallback);
    if (section === "coachSessions") return mergeCoachSessions([], value);
    if (section === "coachTranscripts") return mergeCoachTranscripts([], value);
    if (section === "coachUsage") return normalizeCoachUsage(value);
    return value;
  }

  function sectionUpdatedAt(section) {
    if (!APP_STATE_SECTIONS.includes(section)) return 0;
    return Math.max(0, Number(readStatement.get(section)?.updated_at) || 0);
  }

  // Only call this with an active SQLite write transaction. Shared by CAS,
  // legacy bootstrap and merge updates so all read/modify/write paths have the
  // same locking and strictly increasing revision behavior.
  function writeSectionLocked(section, safeValue) {
    const updatedAt = Math.max(Date.now(), sectionUpdatedAt(section) + 1);
    writeStatement.run(section, JSON.stringify(safeValue), updatedAt);
    if (CORE_SECTIONS.has(section)) metaWriteStatement.run("core_initialized", "1");
    metaWriteStatement.run("schema_version", String(APP_STATE_SCHEMA_VERSION));
    return updatedAt;
  }

  function writeSection(section, value) {
    if (!APP_STATE_SECTIONS.includes(section)) throw new Error(`Unknown app-state section: ${section}`);
    const safeValue = section === "coachSessions"
      ? mergeCoachSessions([], value)
      : section === "coachTranscripts"
        ? mergeCoachTranscripts([], value)
        : section === "coachUsage"
          ? normalizeCoachUsage(value)
        : value;
    return writeTransaction(() => writeSectionLocked(section, safeValue));
  }

  function compareAndSwapSection(section, value, expectedUpdatedAt) {
    if (!APP_STATE_SECTIONS.includes(section)) throw new Error(`Unknown app-state section: ${section}`);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new Error("Invalid section revision");
    return writeTransaction(() => {
      const currentUpdatedAt = sectionUpdatedAt(section);
      if (currentUpdatedAt !== expectedUpdatedAt) return { ok: false, currentUpdatedAt };
      const updatedAt = writeSectionLocked(section, value);
      return { ok: true, updatedAt };
    });
  }

  function mergeSection(section, value) {
    if (!["preferences", "coachTranscripts", "coachUsage"].includes(section)) {
      throw new Error(`Section ${section} does not support merge writes`);
    }
    return writeTransaction(() => {
      const previous = readSection(section);
      const merged = section === "preferences" ? mergePreferenceDefaults(previous, value)
        : section === "coachTranscripts" ? mergeCoachTranscripts(previous, value)
          : mergeCoachUsage(previous, value);
      return writeSectionLocked(section, merged);
    });
  }

  function readAll() {
    const state = {};
    for (const section of APP_STATE_SECTIONS) {
      const value = readSection(section);
      if (value !== undefined) state[section] = value;
    }
    return state;
  }

  function meta(key) {
    return metaReadStatement.get(key)?.value ?? null;
  }

  function mergeLegacyState(legacyState = {}) {
    const incoming = safeObject(legacyState);
    if (Object.keys(incoming).length === 0) return readAll();
    return writeTransaction(() => {
      const existing = readAll();
      const merged = {
      cards: mergeCards(existing.cards, incoming.cards),
      known: mergeKnown(existing.known, incoming.known),
      library: mergeLibrary(existing.library, incoming.library),
      learningExposure: mergeExposure(existing.learningExposure, incoming.learningExposure),
      testResults: mergeTestResults(existing.testResults, incoming.testResults),
      preferences: mergePreferenceDefaults(existing.preferences, incoming.preferences),
      coachSessions: mergeCoachSessions(existing.coachSessions, incoming.coachSessions),
      coachTranscripts: mergeCoachTranscripts(existing.coachTranscripts, incoming.coachTranscripts),
      coachUsage: mergeCoachUsage(existing.coachUsage, {
        ...safeObject(incoming.coachUsage),
        segments: [
          ...safeArray(safeObject(incoming.coachUsage).segments, 512),
          ...safeArray(safeObject(incoming.preferences).voiceUsageSegments, 512),
        ],
      }),
      };
      for (const section of APP_STATE_SECTIONS) writeSectionLocked(section, merged[section]);
      return merged;
    });
  }

  // Schema v3 moved native Voice usage out of browser/preferences-only storage. Existing
  // initialized databases will not run the browser bootstrap migration again, so seed the
  // durable usage section directly from the last persisted preference snapshot on open.
  if (readSection("coachUsage") === undefined) {
    const preferences = safeObject(readSection("preferences"));
    writeSection("coachUsage", {
      segments: safeArray(preferences.voiceUsageSegments, 512),
      active: null,
    });
  }

  return {
    path: databasePath,
    sqlite: db,
    getMeta: (key) => meta(String(key)),
    setMeta: (key, value) => metaWriteStatement.run(String(key), String(value)),
    readSection,
    sectionUpdatedAt,
    writeSection,
    compareAndSwapSection,
    mergeSection,
    readAll,
    mergeLegacyState,
    isCoreInitialized: () => meta("core_initialized") === "1",
    schemaVersion: () => Number(meta("schema_version") || APP_STATE_SCHEMA_VERSION),
    close: () => db.close(),
  };
}
