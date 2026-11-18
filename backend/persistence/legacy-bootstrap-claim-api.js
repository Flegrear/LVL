// A versioned, additive authority fence for browser bootstrap. Its write calls
// the real app-db transaction, which rereads the profile/sync generation under
// BEGIN IMMEDIATE; this handler's earlier GET never owns a later migration.
export async function legacyBootstrapClaimApi(req, res, {
  appDatabase, json, readJsonBody, methodNotAllowed,
} = {}) {
  if (req.method === "GET") {
    json(res, 200, { claim: appDatabase.legacyBootstrapClaim() });
    return true;
  }
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const body = await readJsonBody(req, 48 * 1024 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Object.hasOwn(body, "claim")
    || !Object.hasOwn(body, "legacyState")
    || (body.legacyState !== null
      && (typeof body.legacyState !== "object" || Array.isArray(body.legacyState)))) {
    json(res, 400, { error: "Versioned bootstrap requires an exact claim and a legacyState object or null" });
    return true;
  }
  if (body.legacyState && Object.keys(body.legacyState).some(section =>
    !["cards", "known", "library", "learningExposure", "testResults",
      "preferences", "coachSessions", "coachTranscripts", "coachUsage"].includes(section))) {
    // An unknown future section is not an empty legacy section. Do not silently
    // import only the known subset and then tell its caller all data was saved.
    json(res, 409, { error: "bootstrap_unknown_section",
      message: "A newer Library snapshot contains unknown sections; preserve it unchanged for recovery." });
    return true;
  }
  try {
    const bootstrap = appDatabase.bootstrapLegacyState(body.legacyState || {},
      { expectedClaim: body.claim });
    json(res, 200, { ok: true, bootstrap, claim: appDatabase.legacyBootstrapClaim() });
  } catch (error) {
    if ([400, 409, 413, 503].includes(error?.statusCode)) {
      json(res, error.statusCode, { error: "bootstrap_claim_rejected",
        message: String(error.message || "Bootstrap claim changed").slice(0, 300) });
      return true;
    }
    throw error;
  }
  return true;
}

// Pre-hydration dirty/legacy writes must use the same profile-generation fence
// as the bootstrap snapshot. A standalone /api/app-state section CAS protects
// its revision but cannot distinguish two different SQLite profiles that
// coincidentally have equal revisions.
export async function legacyBootstrapClaimSectionApi(req, res, {
  appDatabase, json, readJsonBody, methodNotAllowed,
} = {}) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req, 48 * 1024 * 1024);
  const section = body?.section;
  const cas = ["cards", "known", "library", "preferences"].includes(section);
  const mergeAllowed = ["preferences", "testResults", "coachSessions",
    "coachTranscripts", "coachUsage"].includes(section);
  if (typeof section !== "string" || !["cards", "known", "library",
    "learningExposure", "testResults", "preferences", "coachSessions",
    "coachTranscripts", "coachUsage"].includes(section)
    || !Object.hasOwn(body || {}, "value") || !body?.claim
    || (body?.merge === true && !mergeAllowed)) {
    json(res, 400, { error: "Invalid versioned bootstrap section write" });
    return true;
  }
  const expected = body.expectedUpdatedAt;
  if (body.merge !== true && (cas || expected != null)
    && (!Number.isSafeInteger(expected) || expected < 0)) {
    json(res, 428, { error: "Exact bootstrap section revision required" });
    return true;
  }
  try {
    const options = { expectedBootstrapClaim: body.claim };
    const result = body.merge === true
      ? { ok: true, updatedAt: appDatabase.mergeSection(section, body.value, options) }
      : cas || expected != null
        ? appDatabase.compareAndSwapSection(section, body.value, expected, null, options)
        : { ok: true, updatedAt: appDatabase.writeSection(section, body.value, options) };
    if (!result.ok) {
      json(res, 409, { error: "app_state_conflict", section,
        currentUpdatedAt: result.currentUpdatedAt });
      return true;
    }
    json(res, 200, { ...result, section, claim: appDatabase.legacyBootstrapClaim() });
  } catch (error) {
    if ([400, 409, 413, 503].includes(error?.statusCode)) {
      json(res, error.statusCode, { error: "bootstrap_claim_rejected", section,
        message: String(error.message || "Bootstrap generation changed").slice(0, 300) });
      return true;
    }
    throw error;
  }
  return true;
}

// A manual keep/restore acknowledges the same original receipt, not whichever
// account happens to own the Library when the review button is clicked.
export async function legacyBootstrapClaimRestoreApi(req, res, {
  appDatabase, json, readJsonBody, methodNotAllowed,
} = {}) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req, 48 * 1024 * 1024);
  try {
    const result = appDatabase.restoreLegacyBootstrapLibrary(
      body?.ids, body?.expectedUpdatedAt,
      { keepAccepted: body?.decision === "keep", expectedClaim: body?.claim ?? null });
    if (!result.ok) {
      json(res, 409, { error: "app_state_conflict", section: "library",
        currentUpdatedAt: result.currentUpdatedAt, reason: result.reason || "revision_changed" });
      return true;
    }
    const receipt = appDatabase.legacyBootstrapRecovery();
    const resolved = new Set(receipt?.resolvedIds || []);
    const candidates = (receipt?.candidates || [])
      .filter(entry => !resolved.has(String(entry.id))).length;
    const overlaps = (receipt?.overlaps || [])
      .filter(entry => !resolved.has(String(entry.id))).length;
    json(res, 200, { ...result, claim: appDatabase.legacyBootstrapClaim(),
      legacyBootstrapRecovery: receipt ? {
        pending: candidates + overlaps, candidates, overlaps,
        acceptedRevision: receipt.acceptedRevision,
        url: "/api/app-state/bootstrap-recovery",
      } : null });
  } catch (error) {
    if ([400, 409, 413, 503].includes(error?.statusCode)) {
      json(res, error.statusCode, { error: "bootstrap_claim_rejected",
        message: String(error.message || "Legacy receipt account changed").slice(0, 300) });
      return true;
    }
    throw error;
  }
  return true;
}
