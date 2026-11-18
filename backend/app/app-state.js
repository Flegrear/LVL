// The app state the browser saves on the server (/api/app-state).
import { APP_STATE_SECTIONS } from "../persistence/app-db.js";
import { appDatabase } from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "./http-helpers.js";

const APP_STATE_CAS_SECTIONS = new Set(["cards", "known", "library", "preferences"]);
// Older clients sent unversioned coach/test snapshots. Merge their independent
// records under the same SQLite revision check; versioned replacements use CAS.
const APP_STATE_LEGACY_MERGE_SECTIONS = new Set(["testResults", "coachSessions", "coachTranscripts", "coachUsage"]);

const MAX_APP_STATE_BODY_BYTES = 48 * 1024 * 1024;

function mergeLegacyAppSection(section, value) {
  // The database owns both the merger and its write lock. Coach sessions and
  // transcripts consequently use the same ordering and sanitation for CAS,
  // explicit legacy imports and unversioned app requests.
  return { ok: true, updatedAt: appDatabase.mergeSection(section, value) };
}

function appStatePayload() {
  const recovery = appDatabase.legacyBootstrapRecovery();
  const unresolved = new Set(recovery?.resolvedIds || []);
  const legacyBootstrapClaimed = appDatabase.getMeta("legacy_bootstrap_claimed") === "1";
  return {
    schemaVersion: appDatabase.schemaVersion(),
    initialized: appDatabase.isCoreInitialized(),
    legacyBootstrapClaimed,
    legacyBootstrap: { version: 1, claimed: legacyBootstrapClaimed },
    databasePath: appDatabase.path,
    state: appDatabase.readAll(),
    revisions: Object.fromEntries(APP_STATE_SECTIONS.map((section) => [section, appDatabase.sectionUpdatedAt(section)])),
    legacyBootstrapRecovery: recovery ? {
      pending: [...recovery.candidates, ...(recovery.overlaps || [])]
        .filter(entry => !unresolved.has(String(entry.id))).length,
      candidates: recovery.candidates.filter(entry => !unresolved.has(String(entry.id))).length,
      overlaps: (recovery.overlaps || []).filter(entry => !unresolved.has(String(entry.id))).length,
      acceptedRevision: recovery.acceptedRevision,
      url: "/api/app-state/bootstrap-recovery",
    } : null,
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
  try {
    if (legacyState) appDatabase.bootstrapLegacyState(legacyState);
  } catch (error) {
    if ([400, 413, 503].includes(error?.statusCode)) {
      json(res, error.statusCode, { error: error.message });
      return true;
    }
    throw error;
  }
  json(res, 200, appStatePayload());
  return true;
}

export async function appStateEndpoint(req, res, url) {
  if (url.pathname === "/api/app-state/bootstrap-recovery/restore") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const body = await readJsonBody(req, MAX_APP_STATE_BODY_BYTES);
    try {
      const result = appDatabase.restoreLegacyBootstrapLibrary(body?.ids, body?.expectedUpdatedAt,
        { keepAccepted: body?.decision === "keep" });
      if (!result.ok) {
        json(res, 409, { error: "app_state_conflict", section: "library",
          message: result.reason === "entry_present" ? "A selected entry now exists in Library; review its accepted version." : "Library changed since recovery review.",
          currentUpdatedAt: result.currentUpdatedAt });
        return true;
      }
      json(res, 200, { ...result, legacyBootstrapRecovery: appStatePayload().legacyBootstrapRecovery });
    } catch (error) {
      if ([400, 413, 503].includes(error?.statusCode)) {
        json(res, error.statusCode, { error: error.message, section: "library" });
        return true;
      }
      throw error;
    }
    return true;
  }
  if (url.pathname === "/api/app-state/bootstrap-recovery") {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    if (url.searchParams.get("summary") === "1") {
      const receipt = appDatabase.legacyBootstrapRecovery();
      const resolved = new Set(receipt?.resolvedIds || []);
      const pending = [...(receipt?.candidates || []), ...(receipt?.overlaps || [])]
        .filter(entry => !resolved.has(String(entry.id)));
      json(res, 200, { pending: pending.length, acceptedRevision: appDatabase.sectionUpdatedAt("library") });
      return true;
    }
    json(res, 200, {
      recovery: appDatabase.legacyBootstrapRecovery(),
      policy: "Review candidate and overlapping legacy entries against the accepted Library and sync deletions before using the Library revision-checked update API.",
    });
    return true;
  }
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
  if (!body || typeof body !== "object" || Array.isArray(body) || !("value" in body)) {
    json(res, 400, { error: "App-state update requires a value" });
    return true;
  }
  try {
  const merge = body.merge === true;
  if (merge && !APP_STATE_LEGACY_MERGE_SECTIONS.has(section) && section !== "preferences") {
    json(res, 400, { error: `Section ${section} does not support merge writes`, section });
    return true;
  }
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
    if (!Number.isSafeInteger(rawExpectedUpdatedAt) || rawExpectedUpdatedAt < 0) {
      json(res, 400, { error: "Invalid app-state section revision", section });
      return true;
    }
    const expectedUpdatedAt = rawExpectedUpdatedAt;
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
  const updatedAt = merge
    ? appDatabase.mergeSection(section, body.value)
    : appDatabase.writeSection(section, body.value);
  // Parked learningExposure retains its old unversioned replacement contract.
  json(res, 200, { ok: true, section, updatedAt,
    ...(merge && section === "preferences" ? { policy: "defaults-only" } : {}),
    ...(section === "learningExposure" && !merge ? { policy: "legacy-replace" } : {}) });
  return true;
  } catch (error) {
    if ([400, 413, 503].includes(error?.statusCode)) {
      json(res, error.statusCode, { error: error.message, section });
      return true;
    }
    throw error;
  }
}
