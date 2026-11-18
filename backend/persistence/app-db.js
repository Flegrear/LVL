import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";

export const APP_STATE_SCHEMA_VERSION = 4;
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
const LEGACY_BOOTSTRAP_MARKER = "legacy_bootstrap_claimed";
const LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY = "legacy_bootstrap_library_recovery_v1";
// A sync-first database may receive a partial cards/known bootstrap before
// its first Library snapshot. Claim Library recovery once, independently of
// other sections, but treat old claimed databases without this marker as
// already closed to new recovery candidates.
const LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY = "legacy_bootstrap_library_capture_v1";
const LEGACY_BOOTSTRAP_PROFILE_KEY = "legacy_bootstrap_profile_v1";
const LEGACY_BOOTSTRAP_SYNC_GENERATION_KEY = "legacy_bootstrap_sync_generation_v1";
const APP_STATE_LIMITS = Object.freeze({ cards: 20_000, known: 100_000, library: 5_000, testResults: 500 });
const MAX_SECTION_BYTES = 48 * 1024 * 1024;

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function enforceLimit(section, amount, limit) {
  if (amount > limit) throw inputError(`${section} exceeds its ${limit}-record limit`, 413);
}

function validateSectionValue(section, value) {
  if (!APP_STATE_SECTIONS.includes(section)) throw inputError(`Unknown app-state section: ${section}`);
  const isArraySection = ["cards", "known", "library", "testResults", "coachSessions", "coachTranscripts"].includes(section);
  if (isArraySection ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value))
    throw inputError(`Invalid ${section} value: expected ${isArraySection ? "array" : "object"}`);
  if (["cards", "library", "testResults"].includes(section) && value.some((item) =>
    !item || typeof item !== "object" || Array.isArray(item) || !String(item.id ?? "")))
    throw inputError(`Invalid ${section} record`);
  if (section === "known" && value.some((item) => typeof item !== "string"))
    throw inputError("Invalid known value: expected string entries");
  if (section === "learningExposure")
    enforceLimit(section, Object.keys(value).length, 10_000);
  if (section === "coachSessions" && value.length > 24)
    throw inputError("coachSessions exceeds its 24-session limit", 413);
  if (section === "coachTranscripts" && value.length > 100)
    throw inputError("coachTranscripts exceeds its 100-transcript limit", 413);
  if (section === "coachUsage" && Array.isArray(value.segments) && value.segments.length > 512)
    throw inputError("coachUsage exceeds its 512-segment limit", 413);
  if (Object.hasOwn(APP_STATE_LIMITS, section)) enforceLimit(section, value.length, APP_STATE_LIMITS[section]);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw inputError(`Invalid ${section} JSON value`);
  if (Buffer.byteLength(encoded) > MAX_SECTION_BYTES) throw inputError(`${section} exceeds its maximum JSON size`, 413);
  return value;
}

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
  for (const card of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
    if (!card || typeof card !== "object") continue;
    const id = String(card.id ?? "");
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || lexicographicallyGreater(cardProgressScore(card), cardProgressScore(previous))) byId.set(id, card);
  }
  enforceLimit("cards", byId.size, 20_000);
  return [...byId.values()];
}

function mergeLibrary(existing, incoming) {
  const byId = new Map();
  for (const entry of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "");
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || Number(entry.updatedAt || entry.addedAt || 0) >= Number(previous.updatedAt || previous.addedAt || 0)) byId.set(id, entry);
  }
  enforceLimit("library", byId.size, 5_000);
  return [...byId.values()];
}

function mergeKnown(existing, incoming) {
  const merged = [...new Set([...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)].map(String).filter(Boolean))];
  enforceLimit("known", merged.length, 100_000);
  return merged;
}

function mergeExposure(existing, incoming) {
  const result = { ...safeObject(existing) };
  for (const [key, raw] of Object.entries(safeObject(incoming))) {
    const next = safeObject(raw);
    const previous = safeObject(result[key]);
    const nextSeen = Number(next.lastSeenAt) || 0;
    const previousSeen = Number(previous.lastSeenAt) || 0;
    result[key] = {
      encounters: Math.max(Number(previous.encounters) || 0, Number(next.encounters) || 0),
      media: Math.max(Number(previous.media) || 0, Number(next.media) || 0),
      lastMedia: String(nextSeen >= previousSeen ? next.lastMedia || "" : previous.lastMedia || "").slice(0, 1000),
      lastSeenAt: Math.max(previousSeen, nextSeen),
    };
  }
  const entries = Object.entries(result);
  enforceLimit("learningExposure", entries.length, 10_000);
  return result;
}

function mergeTestResults(existing, incoming) {
  const byId = new Map();
  for (const result of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
    if (!result || typeof result !== "object") continue;
    const id = String(result.id ?? "");
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || Number(result.completedAt || result.startedAt || 0) >= Number(previous.completedAt || previous.startedAt || 0)) byId.set(id, result);
  }
  enforceLimit("testResults", byId.size, 500);
  return [...byId.values()]
    .sort((a, b) => Number(a.completedAt || a.startedAt || 0) - Number(b.completedAt || b.startedAt || 0));
}

function normalizeCoachSession(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const chatId = String(raw.chatId || "").slice(0, 64);
  if (!/^[0-9a-f-]{20,64}$/i.test(chatId)) return null;
  const updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
  return {
    chatId,
    // Preserve supported session intent; unknown legacy values remain non-authoritative.
    mode: raw.mode === "practice" ? "practice" : "live",
    providerId: String(raw.providerId || ""),
    providerInstanceId: String(raw.providerInstanceId || ""),
    conversationId: raw.conversationId == null ? null : String(raw.conversationId),
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

function mergeCoachSessions(existing, incoming, { rejectOverflow = false } = {}) {
  const bySession = new Map();
  for (const raw of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
    const session = normalizeCoachSession(raw);
    if (!session) continue;
    const key = `${session.chatId}:${session.nativeVoice ? "native-voice" : "text-live"}`;
    const previous = bySession.get(key);
    if (!previous || session.updatedAt > previous.updatedAt) bySession.set(key, session);
  }
  const sorted = [...bySession.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // Old explicit replacements kept the newest 24 sessions. Legacy merges
  // must reject excess independent sessions instead of losing saved chats.
  if (rejectOverflow) enforceLimit("coachSessions", sorted.length, 24);
  return sorted.slice(0, 24);
}

// Provider message identifiers are only unique inside a provider session.
// Older local transcripts had no message ID: preserve their original ordinal
// *and* content when backfilling, rather than deduplicating equal text/times.
// A producer-supplied ID is namespaced by its session before persistence.
// Once minted, the key survives normalization, reopen, CAS and legacy merges.
function coachTranscriptMessageId(transcriptId, transcript, message, index) {
  const original = typeof message.messageId === "string" ? message.messageId : "";
  if (/^(?:v2|legacy):[0-9a-f]{32}$/.test(original)) return original;
  const digest = (parts) => crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  const scope = [transcriptId, String(transcript.providerId || ""), String(transcript.providerInstanceId || ""),
    String(transcript.conversationId || "")];
  if (original) return `v2:${digest([...scope, "client", original])}`;
  const providerEntryId = String(message.providerEntryId || "");
  if (providerEntryId) return `v2:${digest([...scope, "provider", providerEntryId])}`;
  return `legacy:${digest([transcriptId, index, message.role, Number(message.createdAt) || 0, String(message.text || "")])}`;
}

function normalizeCoachTranscript(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id || raw.chatId || "").slice(0, 64);
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) return null;
  const messages = mergeCoachTranscriptMessages([], safeArray(raw.messages, Infinity).map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) return null;
    return {
      role,
      messageId: coachTranscriptMessageId(id, raw, message, index),
      text: String(message.text || "").slice(0, 4000),
      targetText: String(message.targetText || "").slice(0, 4000),
      romanized: String(message.romanized || "").slice(0, 4000),
      baseText: String(message.baseText || "").slice(0, 4000),
      providerEntryId: String(message.providerEntryId || ""),
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
            id: String(message.provider.id || ""),
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
    providerId: String(raw.providerId || ""),
    providerInstanceId: String(raw.providerInstanceId || ""),
    conversationId: raw.conversationId == null ? "" : String(raw.conversationId),
    targetLanguage: String(raw.targetLanguage || "EN").toUpperCase().slice(0, 8),
    baseLanguage: String(raw.baseLanguage || "EN").toUpperCase().slice(0, 8),
    presetId: String(raw.presetId || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 80),
    presetLabel: String(raw.presetLabel || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 160),
    messages,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

function coachTranscriptMessageKey(message) {
  const messageId = String(message?.messageId || "");
  if (/^(?:v2|legacy):[0-9a-f]{32}$/.test(messageId)) return messageId;
  const providerEntryId = String(message?.providerEntryId || "");
  if (providerEntryId) return `provider:${providerEntryId}`;
  return `local:${message?.role || ""}:${Number(message?.createdAt) || 0}:${String(message?.text || "")}`;
}

function mergeCoachTranscriptMessages(existing, incoming) {
  const merged = [];
  const indexByKey = new Map();
  for (const message of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
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
  enforceLimit("coachTranscripts.messages", merged.length, 200);
  return merged;
}

function mergeCoachTranscripts(existing, incoming) {
  const byId = new Map();
  for (const raw of [...safeArray(existing, Infinity), ...safeArray(incoming, Infinity)]) {
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
  enforceLimit("coachTranscripts", byId.size, 100);
  return [...byId.values()]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function normalizeCoachUsage(raw) {
  const source = safeObject(raw);
  const segments = safeArray(source.segments, Infinity).map((segment) => ({
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
        providerId: String(activeRaw.providerId || ""),
        providerInstanceId: String(activeRaw.providerInstanceId || ""),
        startedAt: activeStartedAt,
        updatedAt: Math.max(activeStartedAt, Number(activeRaw.updatedAt) || activeStartedAt),
      }
    : null;
  enforceLimit("coachUsage.segments", mergedSegments.length, 512);
  return { segments: mergedSegments, active };
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
  try {
    // DatabaseSync blocks the calling thread while waiting for another writer.
    // Keep this positive but short; failed contention can be retried by the
    // caller without pinning the server event loop for several seconds.
    db.exec("PRAGMA busy_timeout = 150;");
    // Inspect the existing marker before any schema setup or journal-mode
    // change. Older binaries must never downgrade a newer database on open.
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get();
    if (hasMeta) {
      const version = Number(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value);
      if (Number.isFinite(version) && version > APP_STATE_SCHEMA_VERSION)
        throw new Error(`Unsupported newer app-state schema version ${version}; this build supports ${APP_STATE_SCHEMA_VERSION}`);
    }
    // SQLite cannot change journal_mode inside a transaction. These operational
    // PRAGMAs are separate from the atomic schema/marker setup below.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec("BEGIN IMMEDIATE");
    try {
      // The initial preflight is not authoritative: a newer writer might have
      // committed after it. Recheck under the SAME lock as all setup DDL and
      // the schema marker initialization, before touching any tables.
      const lockedHasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get();
      if (lockedHasMeta) {
        const version = Number(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value);
        if (Number.isFinite(version) && version > APP_STATE_SCHEMA_VERSION)
          throw new Error(`Unsupported newer app-state schema version ${version}; this build supports ${APP_STATE_SCHEMA_VERSION}`);
      }
      db.exec(`
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
      // v3 bootstrap populated every section, including empty ones. A v3 DB
      // with only Library present may instead have received a sync write first.
      // Preserve the old one-shot guard for full historical bootstraps, while
      // permitting a first browser import of sections missing from sync DBs.
      const oldVersion = lockedHasMeta
        ? Number(db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value)
        : 0;
      if (lockedHasMeta && oldVersion > 0 && oldVersion <= 3) {
        const initialized = db.prepare("SELECT value FROM app_meta WHERE key='core_initialized'").get()?.value === "1";
        if (initialized) {
          const saved = new Set(db.prepare("SELECT section FROM app_state").all().map((row) => row.section));
          if (APP_STATE_SECTIONS.every((section) => saved.has(section)))
            db.prepare("INSERT INTO app_meta(key,value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING")
              .run(LEGACY_BOOTSTRAP_MARKER);
        }
      }
      db.prepare(`
        INSERT INTO app_meta(key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(APP_STATE_SCHEMA_VERSION));
      // A database's identity survives restart, but never accidentally carries
      // over when a new SQLite profile is created at the same filesystem path.
      // The second marker is a durable monotonic fence for sync-account and
      // repository mutations. Sync's own metadata writers all update app_meta
      // under SQLite's writer lock, including cross-process and journal writes.
      db.prepare("INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .run(LEGACY_BOOTSTRAP_PROFILE_KEY, crypto.randomUUID());
      db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '0') ON CONFLICT(key) DO NOTHING")
        .run(LEGACY_BOOTSTRAP_SYNC_GENERATION_KEY);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS lvl_bootstrap_sync_insert_v1
        AFTER INSERT ON app_meta WHEN NEW.key = 'sync'
        BEGIN
          UPDATE app_meta SET value = CAST(value AS INTEGER) + 1
            WHERE key = 'legacy_bootstrap_sync_generation_v1';
        END;
        CREATE TRIGGER IF NOT EXISTS lvl_bootstrap_sync_update_v1
        AFTER UPDATE ON app_meta WHEN NEW.key = 'sync' AND NEW.value IS NOT OLD.value
          AND (CASE WHEN json_valid(NEW.value) = 0 OR json_valid(OLD.value) = 0 THEN 1
            ELSE
              json_extract(NEW.value, '$.device') IS NOT json_extract(OLD.value, '$.device')
              OR json_extract(NEW.value, '$.accountId') IS NOT json_extract(OLD.value, '$.accountId')
              OR json_extract(NEW.value, '$.login') IS NOT json_extract(OLD.value, '$.login')
              OR json_extract(NEW.value, '$.repo.owner') IS NOT json_extract(OLD.value, '$.repo.owner')
              OR json_extract(NEW.value, '$.repo.name') IS NOT json_extract(OLD.value, '$.repo.name')
              OR json_extract(NEW.value, '$.encrypted') IS NOT json_extract(OLD.value, '$.encrypted')
              OR json_extract(NEW.value, '$.active') IS NOT json_extract(OLD.value, '$.active')
              OR json_extract(NEW.value, '$.joining') IS NOT json_extract(OLD.value, '$.joining')
              OR json_extract(NEW.value, '$.mode') IS NOT json_extract(OLD.value, '$.mode')
          END)
        BEGIN
          UPDATE app_meta SET value = CAST(value AS INTEGER) + 1
            WHERE key = 'legacy_bootstrap_sync_generation_v1';
        END;
      `);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original setup error. */ }
      throw error;
    }

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
    try { db.exec("BEGIN IMMEDIATE"); }
    catch (error) { throw annotateBusy(error); }
    try {
      assertSupportedSchema();
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw annotateBusy(error);
    }
  }
  function annotateBusy(error) {
    // node:sqlite reports these as ERR_SQLITE_ERROR on some bundled Node
    // versions, with the SQLite reason only in the message.
    if (/^SQLITE_(BUSY|LOCKED)/.test(String(error?.code || ""))
      || (error?.code === "ERR_SQLITE_ERROR" && /database is locked|database is busy/i.test(error.message)))
      error.statusCode = 503;
    return error;
  }
  const metaReadStatement = db.prepare("SELECT value FROM app_meta WHERE key = ?");
  const metaWriteStatement = db.prepare(`
    INSERT INTO app_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  function assertSupportedSchema() {
    const version = Number(metaReadStatement.get("schema_version")?.value);
    if (Number.isFinite(version) && version > APP_STATE_SCHEMA_VERSION)
      throw new Error(`Unsupported newer app-state schema version ${version}; this build supports ${APP_STATE_SCHEMA_VERSION}`);
  }

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
    validateSectionValue(section, safeValue);
    const updatedAt = Math.max(Date.now(), sectionUpdatedAt(section) + 1);
    writeStatement.run(section, JSON.stringify(safeValue), updatedAt);
    if (CORE_SECTIONS.has(section)) metaWriteStatement.run("core_initialized", "1");
    metaWriteStatement.run("schema_version", String(APP_STATE_SCHEMA_VERSION));
    return updatedAt;
  }

  function normalizedSectionValue(section, value) {
    validateSectionValue(section, value);
    const normalized = section === "coachSessions"
      ? mergeCoachSessions([], value, { rejectOverflow: true })
      : section === "coachTranscripts"
        ? mergeCoachTranscripts([], value)
        : section === "coachUsage"
          ? normalizeCoachUsage(value)
          : value;
    return validateSectionValue(section, normalized);
  }

  function writeSection(section, value, { expectedBootstrapClaim = null } = {}) {
    const safeValue = normalizedSectionValue(section, value);
    return writeTransaction(() => {
      if (expectedBootstrapClaim !== null)
        assertLegacyBootstrapClaim(expectedBootstrapClaim, legacyBootstrapClaim());
      return writeSectionLocked(section, safeValue);
    });
  }

  function compareAndSwapSection(section, value, expectedUpdatedAt, onAccepted = null,
    { expectedBootstrapClaim = null } = {}) {
    const safeValue = normalizedSectionValue(section, value);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw inputError("Invalid section revision");
    return writeTransaction(() => {
      if (expectedBootstrapClaim !== null)
        assertLegacyBootstrapClaim(expectedBootstrapClaim, legacyBootstrapClaim());
      const currentUpdatedAt = sectionUpdatedAt(section);
      if (currentUpdatedAt !== expectedUpdatedAt) return { ok: false, currentUpdatedAt };
      const updatedAt = writeSectionLocked(section, safeValue);
      // Sync may record the exact applied Library revision in its own durable
      // journal as part of this write. Throwing here rolls both changes back.
      if (onAccepted) onAccepted(updatedAt);
      return { ok: true, updatedAt };
    });
  }

  function mergeSection(section, value, { expectedBootstrapClaim = null } = {}) {
    if (!["preferences", "testResults", "coachSessions", "coachTranscripts", "coachUsage"].includes(section)) {
      throw inputError(`Section ${section} does not support merge writes`);
    }
    normalizedSectionValue(section, value);
    return writeTransaction(() => {
      if (expectedBootstrapClaim !== null)
        assertLegacyBootstrapClaim(expectedBootstrapClaim, legacyBootstrapClaim());
      const previous = readSection(section);
      const merged = section === "preferences" ? mergePreferenceDefaults(previous, value)
        : section === "testResults" ? mergeTestResults(previous, value)
        : section === "coachSessions" ? mergeCoachSessions(previous, value, { rejectOverflow: true })
        : section === "coachTranscripts" ? mergeCoachTranscripts(previous, value)
          : mergeCoachUsage(previous, value);
      return writeSectionLocked(section, normalizedSectionValue(section, merged));
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

  // This additive claim is a concurrency certificate, not a login credential.
  // The full sync metadata stays in SQLite. Fingerprint the exact stable
  // account/profile projection, not token refresh or sync clock counters:
  // those unrelated updates must not repeatedly reject a valid bootstrap.
  // The monotonic trigger generation still detects A -> B -> A relinks.
  function legacyBootstrapClaim() {
    const profileId = meta(LEGACY_BOOTSTRAP_PROFILE_KEY);
    const rawGeneration = meta(LEGACY_BOOTSTRAP_SYNC_GENERATION_KEY);
    const syncGeneration = Number(rawGeneration);
    const rawSync = meta("sync");
    let accountState = "unknown";
    let accountIdentity = null;
    if (rawSync === null) accountState = "unlinked";
    else {
      try {
        const settings = JSON.parse(rawSync);
        if (settings && typeof settings === "object" && !Array.isArray(settings)) {
          accountState = settings.active || settings.accountId || settings.login
            || settings.repo || settings.token || settings.refreshToken
            ? "linked" : "unlinked";
          // Unlike the exact sync byte fingerprint, this stable account binding
          // does not change when token refresh, counters or lastSyncAt move.
          accountIdentity = [
            String(settings.device || ""), String(settings.accountId || ""),
            String(settings.login || "").toLowerCase(),
            String(settings.repo?.owner || "").toLowerCase(),
            String(settings.repo?.name || "").toLowerCase(),
            settings.encrypted === true, settings.active === true,
            settings.joining === true, String(settings.mode || ""),
          ];
        }
      } catch { /* Unknown or newer local identity must not authorize migration. */ }
    }
    if (typeof profileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(profileId)
      || typeof rawGeneration !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(rawGeneration)
      || !Number.isSafeInteger(syncGeneration) || syncGeneration < 0)
      throw inputError("Unsupported local bootstrap profile authority", 409);
    return {
      version: 1, profileId, syncGeneration,
      syncFingerprint: crypto.createHash("sha256")
        .update(accountIdentity === null
          ? rawSync === null ? "absent-sync" : `unknown-sync:\u0000${rawSync}`
          : JSON.stringify(accountIdentity)).digest("hex"),
      accountFingerprint: accountIdentity === null
        ? rawSync === null ? "unlinked" : "unknown"
        : crypto.createHash("sha256").update(JSON.stringify(accountIdentity)).digest("hex"),
      accountState,
      claimed: meta(LEGACY_BOOTSTRAP_MARKER) === "1",
      libraryCapture: meta(LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY),
      libraryRevision: sectionUpdatedAt("library"),
    };
  }

  function assertLegacyBootstrapClaim(expected, current) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || expected.version !== 1 || expected.profileId !== current.profileId
      || expected.syncGeneration !== current.syncGeneration
      || expected.syncFingerprint !== current.syncFingerprint
      || expected.accountFingerprint !== current.accountFingerprint
      || expected.accountState !== current.accountState
      || expected.claimed !== current.claimed
      || expected.libraryCapture !== current.libraryCapture
      || expected.libraryRevision !== current.libraryRevision)
      throw inputError("Bootstrap profile, sync account or claim generation changed; original Library remains pending", 409);
    if (current.accountState === "unknown")
      throw inputError("Unknown local sync account identity; preserve the legacy Library for review", 409);
  }

  function legacyBootstrapRecovery() {
    const receipt = parseJson(meta(LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY), null);
    return receipt?.version === 1 && Array.isArray(receipt.candidates) ? receipt : null;
  }

  // A recovery choice is made against the current accepted Library. Both the
  // revision comparison and the receipt acknowledgement share the SQLite write
  // lock, so a concurrent sync/delete cannot be overwritten between checks.
  function restoreLegacyBootstrapLibrary(ids, expectedUpdatedAt,
    { keepAccepted = false, expectedClaim = null } = {}) {
    // Library admission deliberately has no per-ID character cap: opaque
    // provider keys may be long and can share an arbitrarily long prefix.
    // Recovery must accept that same exact domain, including old receipts.
    // Bound the selection by the Library's *aggregate* JSON byte budget
    // instead of introducing a lossy, recovery-only 400-character limit.
    if (!Array.isArray(ids) || !ids.length || ids.length > APP_STATE_LIMITS.library
      || ids.some(id => typeof id !== "string" || !id)
      || new Set(ids).size !== ids.length) throw inputError("Invalid recovery entry selection");
    if (Buffer.byteLength(JSON.stringify(ids)) > MAX_SECTION_BYTES)
      throw inputError("Recovery selection exceeds maximum JSON size", 413);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0)
      throw inputError("Invalid Library recovery revision");
    return writeTransaction(() => {
      const currentClaim = legacyBootstrapClaim();
      if (expectedClaim !== null) assertLegacyBootstrapClaim(expectedClaim, currentClaim);
      else if (currentClaim.accountState !== "unlinked")
        throw inputError("A linked Library recovery requires a current versioned profile claim", 400);
      const receipt = legacyBootstrapRecovery();
      if (!receipt) throw inputError("No Library recovery is pending");
      if (receipt.bootstrapProfileId !== currentClaim.profileId
        || receipt.bootstrapAccountFingerprint !== currentClaim.accountFingerprint) {
        // Historical unbound receipts remain exportable, including their
        // original entries and decisions. Absence is not authority to
        // restore them into ANY profile, linked or otherwise.
        throw inputError("This legacy receipt belongs to a different or unverified profile/account", 409);
      }
      const resolved = new Set(receipt.resolvedIds || []);
      const pending = new Map([...receipt.candidates, ...(receipt.overlaps || [])]
        .filter(entry => !resolved.has(String(entry.id)))
        .map(entry => [String(entry.id), entry]));
      if (ids.some(id => !pending.has(id))) throw inputError("Recovery selection is no longer pending");
      const currentUpdatedAt = sectionUpdatedAt("library");
      if (currentUpdatedAt !== expectedUpdatedAt) return { ok: false, currentUpdatedAt };
      if (keepAccepted) {
        metaWriteStatement.run(LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY,
          JSON.stringify({ ...receipt, resolvedIds: [...resolved, ...ids],
            resolutions: { ...(receipt.resolutions || {}), ...Object.fromEntries(ids.map(id => [id, "kept"])) } }));
        return { ok: true, kept: true, updatedAt: currentUpdatedAt, resolvedIds: ids };
      }
      const accepted = readSection("library") || [];
      const acceptedIds = new Set(accepted.map(entry => String(entry.id)));
      if (ids.some(id => acceptedIds.has(id)))
        return { ok: false, currentUpdatedAt, reason: "entry_present" };
      const next = normalizedSectionValue("library", [...accepted, ...ids.map(id => pending.get(id))]);
      const updatedAt = writeSectionLocked("library", next);
      metaWriteStatement.run(LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY,
        JSON.stringify({ ...receipt, resolvedIds: [...resolved, ...ids],
          resolutions: { ...(receipt.resolutions || {}), ...Object.fromEntries(ids.map(id => [id, "restored"])) } }));
      return { ok: true, updatedAt, restoredIds: ids };
    });
  }

  function mergeLegacyStateLocked(incoming) {
    // A partial snapshot is intentionally partial. In particular, a client
    // migrating cards must not initialize or advance an unrelated Library or
    // preference revision; those sections can have newer sync/CAS ownership.
    const existing = readAll();
    const merged = { ...existing };
    const migrationSegments = Object.hasOwn(incoming, "preferences")
      ? safeObject(incoming.preferences).voiceUsageSegments : undefined;
    for (const section of APP_STATE_SECTIONS) {
      const supplied = Object.hasOwn(incoming, section);
      if (!supplied && !(section === "coachUsage" && Array.isArray(migrationSegments) && migrationSegments.length)) continue;
      if (supplied) validateSectionValue(section, incoming[section]);
      const previous = existing[section];
      const value = incoming[section];
      const next = section === "cards" ? mergeCards(previous, value)
        : section === "known" ? mergeKnown(previous, value)
        : section === "library" ? mergeLibrary(previous, value)
        : section === "learningExposure" ? mergeExposure(previous, value)
        : section === "testResults" ? mergeTestResults(previous, value)
        : section === "preferences" ? mergePreferenceDefaults(previous, value)
        : section === "coachSessions" ? mergeCoachSessions(previous, value, { rejectOverflow: true })
        : section === "coachTranscripts" ? mergeCoachTranscripts(previous, value)
        : mergeCoachUsage(previous, {
            ...safeObject(value),
            segments: [
              ...safeArray(safeObject(value).segments, Infinity),
              ...safeArray(migrationSegments, Infinity),
            ],
          });
      const normalized = normalizedSectionValue(section, next);
      merged[section] = normalized;
      if (JSON.stringify(previous) !== JSON.stringify(normalized)) writeSectionLocked(section, normalized);
    }
    return merged;
  }

  // General explicit merges remain additive, including preference/coach
  // migration. Only the browser's initial bootstrap is one-shot.
  function mergeLegacyState(legacyState = {}) {
    const incoming = safeObject(legacyState);
    if (Object.keys(incoming).length === 0) return readAll();
    return writeTransaction(() => mergeLegacyStateLocked(incoming));
  }

  function bootstrapLegacyState(legacyState = {}, { expectedClaim = null } = {}) {
    const incoming = safeObject(legacyState);
    return writeTransaction(() => {
      // Read the actual profile/account generation AFTER taking BEGIN
      // IMMEDIATE, not in the HTTP handler's stale GET preflight.
      const currentClaim = legacyBootstrapClaim();
      if (expectedClaim !== null) assertLegacyBootstrapClaim(expectedClaim, currentClaim);
      else if (currentClaim.accountState !== "unlinked")
        // Old v1 clients have no understood generation contract. Preserve
        // their local snapshot rather than importing it into a linked account.
        throw inputError("This account requires a versioned Library bootstrap claim", 400);
      // Sync can initialize one section before the browser has sent its legacy
      // cards or known words. The old marker records the first migration, but
      // each absent section remains eligible for its own first import. Existing
      // rows (including an intentionally empty Library after sync deletions)
      // are never overwritten by a later legacy snapshot.
      const supplied = APP_STATE_SECTIONS.filter(section => Object.hasOwn(incoming, section));
      if (!supplied.length)
        return { applied: false };
      for (const section of supplied) validateSectionValue(section, incoming[section]);
      const claimed = meta(LEGACY_BOOTSTRAP_MARKER) === "1";
      const libraryCapture = meta(LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY);
      if (expectedClaim !== null && claimed && supplied.includes("library")
        && libraryCapture !== "0")
        // The first Library capture has already been consumed (or an older
        // full bootstrap closed it). A later offered legacy snapshot must not
        // receive a success-shaped empty receipt and then be discarded.
        throw inputError("The first Library recovery claim was already consumed; preserve the browser copy for review", 409);
      const captureLibrary = supplied.includes("library") && (!claimed || libraryCapture === "0");
      const missing = {};
      let receiptChanged = false;
      for (const section of supplied) {
        if (!readStatement.get(section)) {
          missing[section] = incoming[section];
        } else if (section === "library" && captureLibrary) {
          // Sync may have applied A before the browser's first migration. An
          // older browser copy can contain the same A and unique B, but B
          // could also have a remote tombstone unknown to this app-state
          // boundary. Keep the accepted Library and its revision authoritative.
          // Stage unmatched records only for this Library's first snapshot,
          // even when another section was imported earlier. Later stale tabs
          // have no authority to add new candidates after this capture.
          // Never write these records into the causal sync projection.
          const accepted = new Map((readSection("library") || []).map((entry) => [String(entry.id), entry]));
          const receipt = legacyBootstrapRecovery();
          const resolved = new Set(receipt?.resolvedIds || []);
          const candidates = new Map((receipt?.candidates || []).map(entry => [String(entry.id), entry]));
          const overlaps = new Map((receipt?.overlaps || []).map(entry => [String(entry.id), entry]));
          for (const entry of incoming.library) {
            const id = String(entry.id);
            if (resolved.has(id) || candidates.has(id) || overlaps.has(id)) continue;
            if (!accepted.has(id)) { candidates.set(id, entry); receiptChanged = true; }
            else if (JSON.stringify(accepted.get(id)) !== JSON.stringify(entry)) {
              overlaps.set(id, entry);
              receiptChanged = true;
            }
          }
          if (receiptChanged) {
            metaWriteStatement.run(LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY, JSON.stringify({
              ...receipt, version: 1,
              bootstrapProfileId: currentClaim.profileId,
              bootstrapAccountFingerprint: currentClaim.accountFingerprint,
              createdAt: receipt?.createdAt || Date.now(),
              acceptedRevision: sectionUpdatedAt("library"),
              candidates: [...candidates.values()],
              overlaps: [...overlaps.values()],
            }));
          }
        }
      }
      // A first partial bootstrap without Library records the possibility of
      // one later Library capture. Both capture markers and the receipt belong
      // to this same immediate transaction, so a concurrent second process
      // cannot race another candidate set into the accepted first snapshot.
      if (!claimed && libraryCapture === null && !supplied.includes("library"))
        metaWriteStatement.run(LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY, "0");
      if (captureLibrary)
        metaWriteStatement.run(LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY, "1");
      // The row's presence is the section-specific migration claim. Preserving
      // previously written revisions also protects the v3/v4 sync-first path.
      if (!Object.keys(missing).length && claimed && !receiptChanged && !captureLibrary)
        return { applied: false };
      if (Object.keys(missing).length) mergeLegacyStateLocked(missing);
      if (!claimed) metaWriteStatement.run(LEGACY_BOOTSTRAP_MARKER, "1");
      if (Object.keys(missing).length) metaWriteStatement.run("core_initialized", "1");
      return { applied: true, initializedSections: Object.keys(missing), recoveryStaged: receiptChanged };
    });
  }

  return {
    path: databasePath,
    sqlite: db,
    getMeta: (key) => meta(String(key)),
    setMeta: (key, value) => {
      const name = String(key);
      const persist = () => {
        if (name === "schema_version") {
          const version = Number(value);
          // Opening the DB performs the supported upgrade. Metadata clients
          // must never make a v4 database appear writable by a v3 binary.
          if (!Number.isSafeInteger(version) || version !== APP_STATE_SCHEMA_VERSION)
            throw inputError("Unsupported app-state schema version");
          return metaWriteStatement.run(name, String(version));
        }
        if (name === LEGACY_BOOTSTRAP_MARKER || name === "core_initialized"
          || name === LEGACY_BOOTSTRAP_LIBRARY_RECOVERY_KEY
          || name === LEGACY_BOOTSTRAP_LIBRARY_CAPTURE_KEY
          || name === LEGACY_BOOTSTRAP_PROFILE_KEY
          || name === LEGACY_BOOTSTRAP_SYNC_GENERATION_KEY)
          throw inputError(`Metadata ${name} is owned by app-state bootstrap`);
        return metaWriteStatement.run(name, String(value));
      };
      try { return writeTransaction(persist); }
      catch (error) {
        // An incoming app rating is applied under the sync journal's existing
        // BEGIN IMMEDIATE. The recommendations store also updates its
        // recs_settings change stamp. Its app_meta write must join that
        // transaction, not attempt another BEGIN and silently leave a rating
        // unapplied. Mirror sync-service's exact nested-transaction guard:
        // only this non-authoritative recommendations metadata key may use
        // the already-held writer lock; all other keys keep normal admission.
        if (name !== "recs_settings" || error?.code !== "ERR_SQLITE_ERROR"
          || !/cannot start a transaction within a transaction/i.test(error.message)) throw error;
        assertSupportedSchema();
        return persist();
      }
    },
    readSection,
    sectionUpdatedAt,
    writeSection,
    compareAndSwapSection,
    mergeSection,
    readAll,
    mergeLegacyState,
    bootstrapLegacyState,
    legacyBootstrapClaim,
    legacyBootstrapRecovery,
    restoreLegacyBootstrapLibrary,
    isCoreInitialized: () => meta("core_initialized") === "1",
    schemaVersion: () => Number(meta("schema_version") || APP_STATE_SCHEMA_VERSION),
    close: () => db.close(),
  };
  } catch (error) {
    try { db.close(); } catch { /* preserve the actual schema/open error */ }
    throw error;
  }
}
