// The app state the browser saves on the server (/api/app-state).
import { APP_STATE_SECTIONS } from "../persistence/app-db.js";
import { appDatabase } from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "./http-helpers.js";

const APP_STATE_CAS_SECTIONS = new Set(["cards", "known", "library", "preferences"]);

const MAX_APP_STATE_BODY_BYTES = 48 * 1024 * 1024;

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
  // Bootstrap migration is only for an *uninitialized* database. A different
  // browser profile can still have old localStorage with a removed Library
  // title; merging it into the already-initialized shared SQLite database
  // would resurrect deletions in the app window.
  if (legacyState && !appDatabase.isCoreInitialized()) appDatabase.mergeLegacyState(legacyState);
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
  if (!merge && APP_STATE_CAS_SECTIONS.has(section)) {
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
  const updatedAt = merge && typeof appDatabase.mergeSection === "function"
    ? appDatabase.mergeSection(section, body.value)
    : appDatabase.writeSection(section, body.value);
  json(res, 200, { ok: true, section, updatedAt });
  return true;
}
