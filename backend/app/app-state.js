// The app state the browser saves on the server (/api/app-state).
import { APP_STATE_SECTIONS } from "../persistence/app-db.js";
import { appDatabase } from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "./http-helpers.js";

const APP_STATE_CAS_SECTIONS = new Set(["cards", "known", "library", "preferences"]);
// Older clients sent unversioned coach/test snapshots. Merge their independent
// records under the same SQLite revision check; versioned replacements use CAS.
const APP_STATE_LEGACY_MERGE_SECTIONS = new Set(["testResults", "coachSessions", "coachTranscripts", "coachUsage"]);

const MAX_APP_STATE_BODY_BYTES = 48 * 1024 * 1024;

function mergeLegacyAppRecords(section, previous, incoming) {
  const byId = new Map();
  for (const item of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const key = section === "testResults" ? String(item.id || "").slice(0, 200)
      : `${String(item.chatId || "").slice(0, 64)}:${item.nativeVoice ? "native-voice" : "text-live"}`;
    if (!key || (section === "coachSessions" && !/^[0-9a-f-]{20,64}:(?:native-voice|text-live)$/i.test(key))) continue;
    const at = Number(item[section === "testResults" ? "completedAt" : "updatedAt"]
      ?? (section === "testResults" ? item.startedAt : 0)) || 0;
    const prior = byId.get(key);
    if (!prior || at >= prior.at) byId.set(key, { item, at });
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(section === "testResults" ? -500 : -24).map(({ item }) => item);
}

function mergeLegacyAppSection(section, value) {
  if (section === "coachTranscripts" || section === "coachUsage")
    return { ok: true, updatedAt: appDatabase.mergeSection(section, value) };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revision = appDatabase.sectionUpdatedAt(section);
    const merged = mergeLegacyAppRecords(section, appDatabase.readSection(section), value);
    const result = appDatabase.compareAndSwapSection(section, merged, revision);
    if (result.ok) return result;
  }
  return { ok: false, currentUpdatedAt: appDatabase.sectionUpdatedAt(section) };
}

function appStatePayload() {
  return {
    schemaVersion: appDatabase.schemaVersion(),
    initialized: appDatabase.isCoreInitialized(),
    databasePath: appDatabase.path,
    state: appDatabase.readAll(),
    revisions: Object.fromEntries(APP_STATE_SECTIONS.map((section) => [section, appDatabase.sectionUpdatedAt(section)])),
  };
}

export async function appStateBootstrapEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req, MAX_APP_STATE_BODY_BYTES);
  const legacyState = body?.legacyState && typeof body.legacyState === "object" && !Array.isArray(body.legacyState)
    ? body.legacyState
    : null;
  // Check and claim initial migration inside the database's write transaction.
  // An earlier preflight in this handler could race another server process.
  if (legacyState) appDatabase.bootstrapLegacyState(legacyState);
  json(res, 200, appStatePayload());
  return true;
}

export async function appStateEndpoint(req, res, url) {
  if (url.pathname === "/api/app-state") {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    json(res, 200, appStatePayload());
    return true;
  }
  const match = /^\/api\/app-state\/([A-Za-z][A-Za-z0-9]*)$/.exec(url.pathname);
  if (!match) return false;
  const section = match[1];
  if (!APP_STATE_SECTIONS.includes(section)) {
    json(res, 404, { error: "Unknown app-state section" });
    return true;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    json(res, 200, {
      section,
      value: appDatabase.readSection(section) ?? null,
      updatedAt: appDatabase.sectionUpdatedAt(section),
    });
    return true;
  }
  if (req.method !== "PUT" && req.method !== "POST") return methodNotAllowed(res, ["GET", "PUT", "POST"]);
  const body = await readJsonBody(req, MAX_APP_STATE_BODY_BYTES);
  if (!("value" in body)) {
    json(res, 400, { error: "App-state update requires a value" });
    return true;
  }
  const merge = body.merge === true;
  if (!merge && (APP_STATE_CAS_SECTIONS.has(section) || body.expectedUpdatedAt != null)) {
    if (body.expectedUpdatedAt == null) {
      json(res, 428, {
        error: "app_state_revision_required",
        message: `Persistent ${section} replacement requires the current section revision.`,
        section,
        currentUpdatedAt: appDatabase.sectionUpdatedAt(section),
      });
      return true;
    }
    const rawExpectedUpdatedAt = Number(body.expectedUpdatedAt);
    if (!Number.isFinite(rawExpectedUpdatedAt) || rawExpectedUpdatedAt < 0) {
      json(res, 400, { error: "Invalid app-state section revision", section });
      return true;
    }
    const expectedUpdatedAt = Math.floor(rawExpectedUpdatedAt);
    const result = appDatabase.compareAndSwapSection(section, body.value, expectedUpdatedAt);
    if (!result.ok) {
      json(res, 409, {
        error: "app_state_conflict",
        message: `Persistent ${section} changed in another app session.`,
        section,
        expectedUpdatedAt,
        currentUpdatedAt: result.currentUpdatedAt,
      });
      return true;
    }
    json(res, 200, { ok: true, section, updatedAt: result.updatedAt });
    return true;
  }
  if (APP_STATE_LEGACY_MERGE_SECTIONS.has(section)
    && (merge || body.expectedUpdatedAt == null)) {
    const result = mergeLegacyAppSection(section, body.value);
    if (!result.ok) {
      json(res, 409, { error: "app_state_conflict", section, currentUpdatedAt: result.currentUpdatedAt });
      return true;
    }
    json(res, 200, { ok: true, section, updatedAt: result.updatedAt, policy: "merge" });
    return true;
  }
  const updatedAt = merge && typeof appDatabase.mergeSection === "function"
    ? appDatabase.mergeSection(section, body.value)
    : appDatabase.writeSection(section, body.value);
  // Parked learningExposure retains its old unversioned replacement contract.
  json(res, 200, { ok: true, section, updatedAt, ...(section === "learningExposure" && !merge ? { policy: "legacy-replace" } : {}) });
  return true;
}
