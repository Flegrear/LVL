// Sync with a private GitHub repository named lvl-sync: the setup steps and the automatic sync.
// Setup (status().step): "start" (choose renewal, sign in) -> "device" (enter the code at
// github.com/login/device) -> "repo" (LVL finds lvl-sync; the user creates it if needed)
// -> "options" (a new sync: plain files, or encrypted with a passphrase) or "passphrase"
// (joining a sync another device encrypted; joining a plain one needs no step) -> "ready".
// While LVL runs (every 5 s, cheap): this device's own changes are looked for through a
// mark (section times and row counts) and sent on the next check. Every 10 s LVL
// asks GitHub whether lvl-sync changed: one small request, answered "not changed" (304) for
// free. Everything is compared at start, every 10 minutes and on "Sync now".
// One sync: read the files that are new in the repo, apply what changed elsewhere, compare
// LVL's data with what was last synced, and write this device's changes as one new file.
// Nothing is written when nothing synced changed.
// Kept on this device (app_meta "sync"): the sign-in, the repository, the encryption key if
// the sync is encrypted (never the passphrase), the clock and which files were read.
// sync_items: the current change for every synced item, and a hash of what LVL had for it.
import crypto from "node:crypto";
import { createClock, newDeviceId, parseStamp } from "../../shared/sync/clock.js";
import { createRegistry } from "../../shared/sync/records.js";
import { verifiedVideoEpisodeKey, verifiedVideoWorkKey } from "../../shared/sync/video-state.js";
import { deriveKeyBytes, fromBase64, importKeyBytes, newKdfSettings, passphraseMatches, toBase64 } from "../../shared/sync/crypto.js";
import { SETTINGS_FILE, createSyncLog, newSettingsFile, readSettingsFile } from "../../shared/sync/log.js";
import { createSyncJournal } from "./journal.js";

const META_KEY = "sync";
const SYNC_REPO = "lvl-sync";
const CHECK_EVERY_MS = 5_000;
const REMOTE_EVERY_MS = 10_000;
const FULL_EVERY_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const RATE_LIMITED_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 15 * 60_000;
const PROGRESS_BATCH_MS = 10_000;
const RENEW_BEFORE_MS = 5 * 60_000;
const SNAPSHOT_EVERY = 50;

const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  : JSON.stringify(value ?? null));
const hashOf = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex").slice(0, 32);
// A paused player's save can update its time without moving. Keep the original
// playback time on real changes without uploading timestamp-only duplicates.
const itemHash = (type, value) => {
  if (type !== "video.progress" || !value) return hashOf(value);
  const { updatedAt, updatedBy, ...content } = value;
  return hashOf(content);
};
// The watched/progress wire records include descriptive context from their
// parent title. Renaming that title must not make an *unchanged* playback item
// locally authoritative over a newer remote watch/unwatch or seek. The title's
// own video.title record carries its metadata change. Keep the full hashes and
// wire context for real item edits; compare only intent when deciding whether
// a mismatch was caused solely by this derived presentation context.
const playbackIntent = (type, value) => {
  if (!value) return null;
  if (type === "video.progress") {
    const { context, updatedAt, updatedBy, ...intent } = value;
    return intent;
  }
  if (type === "video.watched" || type === "video.imported-watched") {
    const { context, updatedBy, ...intent } = value;
    return intent; // Include watched, explicit action time and account provenance.
  }
  return null;
};
const contextOnlyPlaybackDifference = (type, current, acceptedChange) => {
  const local = playbackIntent(type, current);
  const accepted = acceptedChange?.value;
  let previous = playbackIntent(type, accepted);
  // Older devices may send watched.updatedAt without updatedBy. applyLibrary
  // then stores the trusted HLC timestamp, not the untrusted claimed time.
  // Compare against that same normalized accepted projection, or a later title
  // rename would falsely look like a new local watched action on legacy data.
  if (previous && (type === "video.watched" || type === "video.imported-watched")) {
    if (accepted.updatedAt === 0) {
      // applyLibrary drops a zero watchedChapterUpdatedAt on import. Its
      // subsequent export therefore omits updatedAt; this is not a new watch.
      const { updatedAt, ...storedProjection } = previous;
      previous = storedProjection;
    } else if (Number(accepted.updatedAt) > 0) {
      const stamp = parseStamp(acceptedChange.at);
      if (stamp && !(accepted.updatedBy === stamp.device && Number(accepted.updatedAt) <= stamp.ms))
        previous = { ...previous, updatedAt: stamp.ms };
    }
  }
  return local !== null && previous !== null && hashOf(local) === hashOf(previous);
};
const legacyItemHash = (type, value) => {
  if (!value) return hashOf(value);
  if (type === "video.progress") return hashOf({ positionMs: value.positionMs, durationMs: value.durationMs, finished: value.finished });
  if (type === "video.watched") return hashOf({ watched: value.watched });
  if (type === "video.title") {
    const { libraryId, catalogOnly, externalSource, externalId, anilistSync, ...content } = value;
    return hashOf(content);
  }
  return hashOf(value);
};

export function createSyncService({ db, getMeta, setMeta, github, local, app = {}, repoName = SYNC_REPO, now = Date.now, log = console, timers = { setTimeout, clearTimeout } } = {}) {
  const records = createRegistry(undefined, { now });
  db.exec("CREATE TABLE IF NOT EXISTS sync_items (item_key TEXT PRIMARY KEY, change_json TEXT NOT NULL, local_hash TEXT)");
  db.exec(`CREATE TABLE IF NOT EXISTS sync_recovery_archive (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, scope TEXT NOT NULL, backup_json TEXT NOT NULL
  )`);
  const journal = createSyncJournal(db);
  const read = () => { try { return JSON.parse(getMeta(META_KEY) || "{}") || {}; } catch { return {}; } };
  let settings = read();
  // setMeta() owns its own transaction. Journal/activation already hold the
  // SQLite writer lock, so their checkpoint must use the raw statement.
  const metaInTransaction = db.prepare(`INSERT INTO app_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const writeCheckpointLocked = (value) => {
    try { return setMeta(META_KEY, value); }
    catch (error) {
      // app-db's public setMeta starts its own transaction, which SQLite
      // rejects inside the journal's writer lock. Use the same SQL under that
      // lock. Other failures, including injected persistence errors, propagate.
      if (error?.code !== 'ERR_SQLITE_ERROR' || !/cannot start a transaction within a transaction/i.test(error.message))
        throw error;
      return metaInTransaction.run(META_KEY, value);
    }
  };
  const needsDevice = !settings.device;
  if (needsDevice) settings.device = newDeviceId();
  const save = () => setMeta(META_KEY, JSON.stringify(settings));
  if (needsDevice) save();
  let device = null; // the device sign-in in progress
  let startingDevice = null; // pending device-code request and its connection intent
  let running = null;
  let runningOptions = null;
  let timer = null;
  let lastError = "";
  let reloadNeeded = 0;
  let repoMissing = false;
  let stopped = false;
  let closing = false;
  let stopPromise = null;
  // The local mark last compared, and when each check last ran.
  let comparedMark = null;
  let lastRemoteAt = 0;
  let lastFullAt = 0;
  let lastCheckAt = 0;
  let retryAt = 0;
  let rateLimited = false;
  let storageCache = null;
  let accountEpoch = 0;
  let authGeneration = 0;
  let lastObservedHead = null;
  let progressDeadline = 0;
  const scope = () => `${settings.device}:${settings.repo?.owner || ""}/${settings.repo?.name || ""}:${settings.encrypted ? "encrypted" : "plain"}`;
  // Causal projection proofs belong to the exact device/repository/format
  // scope. A different sign-in cannot inherit another account's accepted HLC.
  const bindLocalCausality = (value = scope()) => local.setCausalScope?.(value);
  bindLocalCausality();
  const saveCredentials = () => {
    const previous = getMeta(META_KEY);
    const updated = JSON.stringify(settings);
    const pending = journal.load();
    if (pending) {
      if (pending.scope !== scope()) throw new Error("Cannot authorize an unfinished sync for a different repository");
      journal.rebindCheckpoint(pending.operationId, previous, updated, () => writeCheckpointLocked(updated));
    } else setMeta(META_KEY, updated);
  };
  const assertEpoch = (epoch) => {
    if (stopped || epoch !== accountEpoch || step() !== "ready")
      throw Object.assign(new Error("Sync account changed while an operation was running; the original journal was preserved"), { code: "sync_account_changed" });
  };
  const setupAlive = (epoch) => {
    if (stopped || closing || epoch !== accountEpoch)
      throw Object.assign(new Error("Sync setup was cancelled or stopped"), { code: "sync_setup_cancelled", status: 409 });
  };
  const accountMatches = (user) => {
    if (!user?.login) return false;
    if (settings.accountId)
      return Number.isSafeInteger(Number(user.id)) && Number(settings.accountId) === Number(user.id);
    // Login-only legacy installations bind a verified account ID on reauth.
    // Missing login must fail closed rather than authorize an arbitrary user.
    return Boolean(settings.login && settings.login.toLowerCase() === user.login.toLowerCase());
  };
  const discardUnactivatedForeignRepo = (user) => {
    if (settings.active || !settings.repo || accountMatches(user)) return;
    // A repository selected while signed in as A must not remain selected
    // after signing in as B. If this installation has any accepted history,
    // require the existing recovery flow instead of silently discarding it.
    if (journal.load() || db.prepare('SELECT 1 FROM sync_items LIMIT 1').get())
      throw Object.assign(new Error('Recover the original repository before switching GitHub accounts'), {
        code: 'sync_pending', status: 409,
      });
    Object.assign(settings, { repo: null, joining: false, encrypted: false, key: '', kdf: null,
      seen: {}, deferredPaths: [], nextSeq: 1, remoteHead: '', snapshotVersion: null });
    storageCache = null;
    lastObservedHead = null;
    comparedMark = null;
  };
  const rejectAccount = () => Object.assign(new Error("Reconnect the original GitHub account to recover its sync and pending edits"), { code: "sync_account_mismatch", status: 409 });
  const requireJoiningEncrypted = () => {
    if (settings.active || !settings.joining || !settings.repo)
      throw Object.assign(new Error("Passphrase is available only while joining an existing encrypted sync"), { code: "sync_invalid_transition", status: 409 });
  };
  const requireIdle = () => {
    if (running) throw Object.assign(new Error("Sync is still in progress; finish its pending publication before changing accounts"), { code: "sync_in_progress", status: 409 });
    if (journal.load()) throw Object.assign(new Error("An unfinished sync must be recovered with its original account before changing accounts"), { code: "sync_pending", status: 409 });
  };

  const step = () => {
    if (device) return "device";
    if (!settings.token) return "start";
    if (!settings.repo) return "repo";
    if (!settings.active) return settings.joining && settings.encrypted ? "passphrase" : "options";
    return "ready";
  };
  const storageFor = () => {
    const key = `${settings.repo.owner}/${settings.repo.name}`;
    const token = settings.token;
    if (storageCache?.key !== key || storageCache?.token !== token)
      storageCache = { key, token, storage: github.storage({ token: () => token, owner: settings.repo.owner, repo: settings.repo.name }) };
    return storageCache.storage;
  };

  // Setup is done: from now on this device syncs (keyBytes only for an encrypted sync).
  function activate(keyBytes, extra = {}) {
    requireIdle();
    if (stopped || closing) throw Object.assign(new Error("Sync setup stopped"), { code: "sync_setup_cancelled", status: 409 });
    accountEpoch++;
    const updated = { ...settings, ...extra, active: true, key: keyBytes ? toBase64(keyBytes) : "", seen: {}, nextSeq: 1, joining: false, remoteHead: "" };
    // Initial activation's item reset and metadata must commit as one unit.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM sync_items");
      writeCheckpointLocked(JSON.stringify(updated));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    settings = updated;
    comparedMark = null;
    lastObservedHead = null;
    progressDeadline = 0;
    rateLimited = false;
    retryAt = 0;
    lastFullAt = 0;
    schedule(500);
  }

  async function ensureToken() {
    if (!settings.expiresAt || now() < settings.expiresAt - RENEW_BEFORE_MS) return;
    if (!settings.refreshToken) throw Object.assign(new Error("The GitHub sign-in ended; sign in again"), { code: "signed-out" });
    const epoch = accountEpoch;
    const answer = await github.refresh({ clientId: app.clientId, refreshToken: settings.refreshToken });
    assertEpoch(epoch);
    if (!answer.access_token) throw Object.assign(new Error("The GitHub sign-in couldn't renew; sign in again"), { code: "signed-out" });
    keepToken(answer);
  }
  // lvl-sync was cleared or made again (the user can do that on GitHub): lvl-sync.json is
  // written again, and when this device's own files are gone too, it sends all its data
  // again, as on its first sync. Another device's files already there are read as usual.
  async function recoverStorage(storage, pulled, epoch) {
    if (!pulled.paths.has(SETTINGS_FILE)) {
      if (settings.key && !settings.kdf) throw Object.assign(new Error("lvl-sync.json is gone and this device can't write it again; disconnect and set up sync again"), { code: "set-up-again" });
      const text = settings.key ? await newSettingsFile({ key: await importKeyBytes(fromBase64(settings.key)), kdf: settings.kdf }) : await newSettingsFile();
      assertEpoch(epoch);
      try { await storage.write(SETTINGS_FILE, text, {}); }
      catch (error) {
        if (error.code !== "conflict") throw error;
        // A second device may have recreated the settings while this device
        // was awaiting GitHub. Check the actual winning format and key before
        // a subsequent append can publish in the wrong cipher.
        const current = (await storage.list()).find(file => file.path === SETTINGS_FILE);
        if (!current) throw error;
        const remote = readSettingsFile(await storage.read(SETTINGS_FILE, current.version));
        const encrypted = Boolean(settings.key);
        if (Boolean(remote.encrypted) !== encrypted
          || (encrypted && (!remote.check || !remote.kdf
            || !await passphraseMatches(await importKeyBytes(fromBase64(settings.key)), remote.check))))
          throw Object.assign(new Error("The repository settings changed while recovering; reconnect the original sync before publishing"), {
            code: "sync_repo_settings_changed", status: 409,
          });
      }
    }
    const own = (path) => path.startsWith(`changes/${settings.device}/`) || path === `snapshots/${settings.device}.json`;
    const mine = Object.keys(settings.seen || {}).filter(own);
    if (!mine.length || mine.some((path) => pulled.paths.has(path))) return false;
    for (const path of mine) delete pulled.seen[path];
    pulled.nextSeq = 1;
    // This remote observation may already be stale when an awaited GitHub
    // call resolves. The actual item reset belongs inside journal admission's
    // locked checkpoint comparison, never here before ownership is checked.
    return true;
  }

  function keepToken(answer, extra = {}) {
    const original = { ...settings };
    Object.assign(settings, extra);
    settings.token = answer.access_token;
    settings.refreshToken = answer.refresh_token || "";
    settings.expiresAt = answer.expires_in ? now() + Number(answer.expires_in) * 1000 : 0;
    storageCache = null;
    try { saveCredentials(); } catch (error) { settings = original; throw error; }
  }

  function loadItems() {
    const state = new Map();
    const hashes = new Map();
    for (const row of db.prepare("SELECT item_key, change_json, local_hash FROM sync_items").all()) {
      state.set(row.item_key, JSON.parse(row.change_json));
      if (row.local_hash) hashes.set(row.item_key, row.local_hash);
    }
    return { state, hashes };
  }
  const pendingRecovery = () => {
    const operation = journal.load();
    const { state, hashes } = loadItems();
    // Ordinary Library rows are not pending sync edits before this installation
    // has ever activated a repository. Durable accepted rows or an outbox still
    // require recovery even if the account metadata is incomplete.
    const hasSyncHistory = Boolean(settings.active && settings.repo) || state.size > 0;
    if (!hasSyncHistory) return { pending: Boolean(operation), journal: Boolean(operation),
      localEdits: 0, scope: scope(), acceptedItems: 0, canArchive: true };
    const exported = new Map(local.export().map(item => [
      `${item.type} ${item.id}`, { type: item.type, value: records.clean(item.type, item.value) }]));
    let localEdits = 0;
    for (const [itemKey, item] of exported)
      if (hashes.get(itemKey) !== itemHash(item.type, item.value)) localEdits++;
    for (const [itemKey, change] of state)
      if (local.types.includes(change.type) && change.value !== null && hashes.has(itemKey) && !exported.has(itemKey)) localEdits++;
    return { pending: Boolean(operation || localEdits), journal: Boolean(operation), localEdits,
      scope: scope(), acceptedItems: state.size, canArchive: true };
  };
  const listArchives = () => db.prepare('SELECT id, created_at, scope FROM sync_recovery_archive ORDER BY created_at DESC').all()
    .map(row => ({ id: row.id, createdAt: row.created_at,
      repo: String(row.scope).split(':')[1]?.slice(0, 160) || '' }));
  const putItem = db.prepare(`INSERT INTO sync_items (item_key, change_json, local_hash) VALUES (?, ?, ?)
    ON CONFLICT(item_key) DO UPDATE SET change_json = excluded.change_json, local_hash = excluded.local_hash`);

  async function publishPrepared(plan, syncLog, epoch = accountEpoch) {
    assertEpoch(epoch);
    if (plan.scope !== scope()) throw new Error("An unfinished sync belongs to a different repository or device; reconnect to the original sync to recover it");
    bindLocalCausality(plan.scope);
    if (plan.baseCheckpoint !== undefined && getMeta(META_KEY) !== plan.baseCheckpoint)
      throw Object.assign(new Error("Sync checkpoint advanced in another process; retry with its current state"), { code: "sync_generation_changed" });
    let seq = plan.seq;
    for (let offset = plan.nextChunk * 2000; offset < plan.outgoing.length; offset += 2000) {
      if (plan.scope !== scope()) throw new Error("The sync account or repository changed before publication completed");
      const pushed = await syncLog.push(plan.outgoing.slice(offset, offset + 2000), seq);
      assertEpoch(epoch);
      plan.seen[pushed.path] = pushed.version;
      if (seq % SNAPSHOT_EVERY === 0)
        plan.snapshotVersion = await syncLog.snapshot(plan.state.map(([, change]) => change), seq, plan.snapshotVersion);
      assertEpoch(epoch);
      seq += 1;
      plan.seq = seq;
      plan.nextChunk += 1;
      journal.save(plan, plan.baseCheckpoint);
    }
    if (plan.scope !== scope()) throw new Error("The sync account or repository changed before its checkpoint");
    assertEpoch(epoch);
    const nextSettings = { ...settings, seen: plan.seen, nextSeq: seq, clock: plan.clock, hashVersion: 2,
      deferredPaths: plan.deferredPaths || [], snapshotVersion: plan.snapshotVersion || null,
      lastSyncAt: now(), sent: (settings.sent || 0) + plan.outgoing.length,
      received: (settings.received || 0) + plan.received,
      skippedFiles: (settings.skippedFiles || 0) + plan.skipped.length,
      refused: (settings.refused || 0) + plan.refused,
      ...(plan.remoteChanged && plan.remoteHead ? { remoteHead: plan.remoteHead } : {}) };
    // SQLite rolls back all item rows and the checkpoint if any individual row
    // fails. The outbox remains recoverable until that same commit deletes it.
    journal.commit(plan.operationId, () => {
      if (plan.resetOwnFiles) db.exec("DELETE FROM sync_items");
      for (const [itemKey, json, hash] of plan.updates) putItem.run(itemKey, json, hash);
      // Local authored events are not applied through the inbound producer
      // route. Persist their original, prepared projection/HLC under the same
      // commit as sync_items; later independent edits invalidate that proof.
      local.recordAuthoredCausal?.(plan.outgoing, plan.causalProjections || []);
      writeCheckpointLocked(JSON.stringify(nextSettings));
    }, plan.baseCheckpoint);
    settings = nextSettings;
    reloadNeeded += plan.appliedVideo;
    lastCheckAt = now();
    if (plan.sendLocal) comparedMark = plan.mark;
    if (plan.full) lastFullAt = plan.startedAt;
    // An incoming-only poll may apply unrelated remote edits while a local
    // playhead batch is waiting. Its original upload deadline must survive.
    if (plan.sendLocal) progressDeadline = 0;
    return { sent: plan.outgoing.length, received: plan.received, skippedFiles: plan.skipped, refused: settings.refused };
  }

  // full: read the repository's file list and compare all local data, whatever the marks say.
  // compareLocal: send this device's changes (false for an incoming-only check).
  async function syncOnce({ full = true, compareLocal = true } = {}, generationRetries = 0) {
    if (step() !== "ready") return { skipped: true };
    bindLocalCausality();
    const epoch = accountEpoch;
    await ensureToken();
    assertEpoch(epoch);
    const baseCheckpoint = getMeta(META_KEY);
    if (baseCheckpoint !== JSON.stringify(settings)) {
      if (generationRetries >= 2) throw Object.assign(new Error("Sync checkpoint keeps changing; retry this operation"), { code: "sync_generation_changed" });
      settings = read();
      storageCache = null;
      comparedMark = null;
      return syncOnce({ full, compareLocal }, generationRetries + 1);
    }
    const storage = storageFor();
    const prior = journal.load();
    if (prior && prior.scope !== scope())
      throw new Error("An unfinished sync belongs to another device or repository; reconnect to that sync before continuing");
    const key = settings.key ? await importKeyBytes(fromBase64(settings.key)) : null;
    assertEpoch(epoch);
    const syncLog = createSyncLog({ storage, device: settings.device, key, now });
    if (prior?.phase === "prepared") return publishPrepared(prior, syncLog, epoch);
    const restoring = prior?.phase === "preapply";
    const operationId = restoring ? prior.operationId : crypto.randomUUID();
    const startedAt = restoring ? prior.startedAt : now();
    // The storage's version (GitHub: the branch's commit; "not changed" costs no quota) and this device's mark.
    const head = restoring ? (prior.remoteHead ? { version: prior.remoteHead } : null)
      : typeof storage.head === "function" ? await storage.head() : null;
    assertEpoch(epoch);
    lastRemoteAt = now();
    const remoteChanged = restoring ? prior.remoteChanged : full || Boolean(settings.deferredPaths?.length)
      || !head || head.version !== (lastObservedHead ?? settings.remoteHead);
    let mark = restoring ? prior.mark : local.mark?.() ?? null;
    let sendLocal = restoring ? prior.sendLocal : full || (compareLocal && (mark === null || mark !== comparedMark));
    const checkedFull = restoring ? prior.full : full;
    if (!remoteChanged && !sendLocal) {
      lastCheckAt = now();
      return { sent: 0, received: 0, skippedFiles: [], refused: settings.refused || 0, idle: true };
    }
    const clock = createClock({ device: settings.device, last: settings.clock, now });
    const pulled = restoring ? prior.pulled : remoteChanged ? await syncLog.pull(settings.seen || {},
      { retryPaths: settings.deferredPaths || [] })
      : { changes: [], seen: settings.seen || {}, skipped: [], deferred: settings.deferredPaths || [], nextSeq: settings.nextSeq || 1 };
    assertEpoch(epoch);
    const resetOwnFiles = restoring ? Boolean(prior.resetOwnFiles)
      : pulled.paths ? await recoverStorage(storage, pulled, epoch) : false;
    assertEpoch(epoch);
    for (const change of pulled.changes) {
      const inspected = records.read(change);
      if (inspected.status !== "invalid" && inspected.status !== "future") clock.observe(inspected.change.at);
    }
    // Full scans must still inspect the remote tree and *actual* local hashes.
    // When nothing has changed, don't create and remove a SQLite journal just
    // to say that the repository was checked.
    if (!restoring && !resetOwnFiles && settings.hashVersion === 2
      && pulled.changes.length === 0 && !(pulled.deferred?.length)
      && stable(pulled.seen) === stable(settings.seen)) {
      const { state, hashes } = loadItems();
      const projection = new Map(local.export().map((item) =>
        [`${item.type} ${item.id}`, { type: item.type, value: records.clean(item.type, item.value) }]));
      const sameLocal = [...projection].every(([itemKey, item]) => hashes.get(itemKey) === itemHash(item.type, item.value));
      const noUnapplied = [...state].every(([itemKey, change]) =>
        !local.types.includes(change.type) || (records.read(change).status === "ok"
          && hashes.has(itemKey) && (projection.has(itemKey) || change.value === null)));
      // A remote-only check does not own the pending local edit. It can return
      // idle even while a durable playhead is waiting for its upload deadline,
      // provided no incoming or previously unapplied remote records were found.
      if (noUnapplied && (!sendLocal || sameLocal)) {
        // The incoming-only poll did not acknowledge any local projection.
        // Advancing this mark would silently suppress the waiting upload.
        if (sendLocal && sameLocal) comparedMark = mark;
        lastCheckAt = now();
        if (checkedFull) lastFullAt = startedAt;
        if (head) lastObservedHead = head.version;
        return { sent: 0, received: 0, skippedFiles: [], refused: settings.refused || 0, idle: true };
      }
    }
    const localProjection = () => local.export().map((item) =>
      [`${item.type} ${item.id}`, records.clean(item.type, item.value)]);
    // Capture pending local edits before a pull can replace them. An unchanged
    // cached value is not an edit; only a difference from the last accepted hash
    // protects a record. The next send stamps that genuine edit after the pull.
    const pending = restoring ? new Map(prior.pending)
      : new Map((remoteChanged || settings.hashVersion !== 2 ? local.export() : []).map(item =>
        [`${item.type} ${item.id}`, records.clean(item.type, item.value)]));
    // The expected projection is journaled atomically at admission and again
    // alongside each local-apply transaction. This covers Comics/ratings and
    // the preapply-before-video-CAS gap, not only a committed video Library.
    const intervening = new Map();
    if (restoring && Array.isArray(prior.expectedLocal)) {
      const after = new Map(prior.expectedLocal);
      const current = new Map(localProjection());
      for (const itemKey of new Set([...after.keys(), ...current.keys()])) {
        const oldValue = after.get(itemKey) ?? null;
        const newValue = current.get(itemKey) ?? null;
        if (stable(oldValue) !== stable(newValue)) {
          intervening.set(itemKey, newValue);
          pending.set(itemKey, newValue);
        }
      }
      if (intervening.size) sendLocal = true;
    } else if (restoring && Array.isArray(prior.appliedLibrary) && typeof local.exportLibrarySnapshot === "function") {
      // Accept unfinished journals saved by older builds without assuming the
      // pre-CAS baseline for non-video records was captured durably.
      const after = new Map(local.exportLibrarySnapshot(prior.appliedLibrary)
        .map((item) => [`${item.type} ${item.id}`, records.clean(item.type, item.value)]));
      const current = new Map(local.exportLibrarySnapshot()
        .map((item) => [`${item.type} ${item.id}`, records.clean(item.type, item.value)]));
      for (const itemKey of new Set([...after.keys(), ...current.keys()])) {
        const oldValue = after.get(itemKey) ?? null;
        const newValue = current.get(itemKey) ?? null;
        if (stable(oldValue) !== stable(newValue)) {
          intervening.set(itemKey, newValue);
          pending.set(itemKey, newValue);
        }
      }
      if (intervening.size) sendLocal = true;
    }
    // Recover the exact pulled records and original local baseline after any
    // interruption during local application, before another remote read.
    if (!restoring) {
      try { journal.save({ phase: "preapply", operationId, scope: scope(), startedAt,
      remoteChanged, remoteHead: head?.version || null, mark, sendLocal, full: checkedFull,
      pulled: { changes: pulled.changes, seen: pulled.seen, skipped: pulled.skipped,
        deferred: pulled.deferred || [], nextSeq: pulled.nextSeq },
      pending: [...pending], baseCheckpoint, resetOwnFiles }, baseCheckpoint, (operation) => {
        // Record old hashes, causal changes and local intent before resetting.
        // Both the baseline journal and table deletion share a writer lock.
        if (resetOwnFiles) {
          operation.baselineRows = db.prepare("SELECT item_key, change_json, local_hash FROM sync_items").all();
          db.exec('DELETE FROM sync_items');
        }
        const captured = localProjection();
        operation.expectedLocal = captured;
        if (remoteChanged || settings.hashVersion !== 2) {
          pending.clear();
          for (const [key, value] of captured) pending.set(key, value);
          operation.pending = captured;
        }
        mark = local.mark?.() ?? null;
        operation.mark = mark;
      }); }
      catch (error) {
        if (error.code !== "sync_generation_changed" || generationRetries >= 2) throw error;
        settings = read();
        storageCache = null;
        comparedMark = null;
        return syncOnce({ full, compareLocal }, generationRetries + 1);
      }
    }
    if (resetOwnFiles && !restoring) log.warn?.("Sync: lvl-sync no longer has this device's files; restoring the durable baseline");
    const { state, hashes } = loadItems();
    const baselineRows = resetOwnFiles ? (restoring ? prior.baselineRows : journal.load()?.baselineRows) : null;
    if (Array.isArray(baselineRows)) {
      state.clear(); hashes.clear();
      for (const row of baselineRows) {
        state.set(row.item_key, JSON.parse(row.change_json));
        if (row.local_hash) hashes.set(row.item_key, row.local_hash);
      }
    }
    const before = new Map(state);
    // Enriching the format is not a user edit. Upgrade confirmed, unchanged
    // hashes before deciding whether this older installation has pending edits.
    const rehashed = new Set();
    if (settings.hashVersion !== 2) for (const [itemKey, hash] of hashes) {
      const type = before.get(itemKey)?.type;
      if (!local.types.includes(type)) continue;
      const value = pending.has(itemKey) ? pending.get(itemKey) : null;
      if (legacyItemHash(type, value) !== hash) continue;
      hashes.set(itemKey, itemHash(type, value));
      rehashed.add(itemKey);
    }
    const dirty = new Set();
    if (remoteChanged) for (const [itemKey, hash] of hashes) {
      const previous = before.get(itemKey);
      if (!local.types.includes(previous?.type)) continue;
      const value = pending.has(itemKey) ? pending.get(itemKey) : null;
      if (itemHash(previous.type, value) === hash) continue;
      // Adding provenance to an accepted value must not protect a stale copy
      // from a newer remote edit. Existing provenance remains part of identity.
      const prior = value && { ...value };
      if (prior && !Object.hasOwn(previous.value || {}, "anilistSync")) delete prior.anilistSync;
      if (prior && !Object.hasOwn(previous.value || {}, "provenance")) delete prior.provenance;
      if (itemHash(previous.type, prior) !== hash
        && !contextOnlyPlaybackDifference(previous.type, prior, previous)) dirty.add(itemKey);
    }
    if (restoring && resetOwnFiles && !Array.isArray(prior.baselineRows)) {
      // Legacy preapply journals deleted hashes before the baseline was saved.
      // Protect their captured local values instead of guessing they are clean.
      for (const itemKey of pending.keys()) dirty.add(itemKey);
    }
    const arrived = records.merge(state, pulled.changes);
    // A new installation can have exactly the same seeded item as an existing
    // repository (notably the built-in Keiyoushi Comics repository). It is not
    // a competing local edit when the full cleaned value agrees. Comparing
    // after merge lets that remote record apply and retain its original HLC,
    // instead of manufacturing a newer outgoing event and under-counting the
    // received batch. A genuinely distinct local value still stays dirty and
    // wins the initial join by receiving its own authored stamp.
    if (remoteChanged) for (const [itemKey, value] of pending) {
      if (value === null || hashes.has(itemKey) || before.has(itemKey)) continue;
      const type = itemKey.slice(0, itemKey.indexOf(' '));
      if (!local.types.includes(type)) continue;
      const remote = state.get(itemKey);
      if (remote && remote.value !== null && records.read(remote).status === "ok"
        && itemHash(type, remote.value) === itemHash(type, value)) continue;
      dirty.add(itemKey);
    }
    const touched = new Set(arrived.map((change) => `${change.type} ${change.id}`));
    // Preserve a genuine pending local title edit, while accepting a newer
    // *same-account* imported display snapshot from its admitted remote title.
    // The latter has no authentication authority and must not be overwritten
    // just because the local user changed artwork during a first-time join.
    if (typeof local.reconcileImportedSnapshot === "function") for (const change of arrived) {
      if (change.type !== "video.title" || !dirty.has(`${change.type} ${change.id}`)) continue;
      assertEpoch(epoch);
      local.reconcileImportedSnapshot(change);
    }
    for (const itemKey of intervening.keys()) {
      dirty.add(itemKey);
      const accepted = state.get(itemKey);
      if (accepted && !hashes.has(itemKey)) hashes.set(itemKey, itemHash(accepted.type, accepted.value));
    }
    // A title can reach a device *after* another source for the same verified
    // series already contributed watched/unwatched records. Those account
    // records are accepted in sync_items and do not appear in this pull again.
    // Reapply only their existing causal records when a newly eligible source
    // arrives, so its Library entry gains the same replica/stamp without a
    // synthetic author, a newer HLC or a redundant remote PUT.
    const newWorks = new Set();
    for (const [itemKey, change] of state) {
      if (change.type !== "video.title" || !change.value || !touched.has(itemKey)) continue;
      const work = verifiedVideoWorkKey(change.value);
      // A metadata-only remote edit to an already verified source does not
      // justify rewriting every historical watched row in this Library.
      if (work && verifiedVideoWorkKey(before.get(itemKey)?.value) !== work) newWorks.add(work);
    }
    if (sendLocal) for (const item of local.export()) {
      if (item.type !== "video.title" || !item.value) continue;
      const previous = before.get(`video.title ${item.id}`);
      const work = verifiedVideoWorkKey(item.value);
      if (work && (!previous?.value || verifiedVideoWorkKey(previous.value) !== work)) newWorks.add(work);
    }
    const historyToReplay = new Set();
    if (newWorks.size) for (const [itemKey, change] of state) {
      if (change.type !== "video.watched" && change.type !== "video.imported-watched") continue;
      if (!change.value || dirty.has(itemKey) || records.read(change).status !== "ok") continue;
      let code;
      try { code = decodeURIComponent(change.id.split("/")[1]); } catch { continue; }
      const context = change.value.context;
      const episode = verifiedVideoEpisodeKey(context, code);
      if (episode && newWorks.has(episode.slice(0, episode.lastIndexOf(":"))))
        historyToReplay.add(itemKey);
    }
    // Changes for LVL's data that couldn't be applied before (an episode before its title) are tried again.
    const toApply = [...state.entries()].filter(([itemKey, change]) => local.types.includes(change.type)
      // The journal retains opaque future-schema records for compatible peers.
      // They must not be materialized by this older producer or acknowledged
      // merely because their type name is locally recognized.
      && records.read(change).status === "ok"
      && !dirty.has(itemKey)
      && !(change.type.startsWith("video.") && dirty.has(`video.title ${change.id.split("/")[0]}`)
        && !pending.has(`video.title ${change.id.split("/")[0]}`))
      && (touched.has(itemKey) || !hashes.has(itemKey) || historyToReplay.has(itemKey))).map(([, change]) => change);
    assertEpoch(epoch);
    bindLocalCausality();
    const applied = toApply.length ? local.apply(toApply, before, {
      onLibraryApplied: (result) => journal.recordAppliedLibrary(operationId, result, localProjection),
      applyOtherAtomically: (apply) => journal.applyAndRecord(operationId, apply, localProjection),
    }) : new Set();
    // What LVL has now, after applying. A received item counts as in sync with its local form
    // (LVL may add its own fields, like when it was added), so it isn't sent back.
    const current = sendLocal || applied.size ? local.export().map((item) => ({ ...item, key: `${item.type} ${item.id}`, value: records.clean(item.type, item.value) })) : [];
    const byKey = new Map(current.map((item) => [item.key, item]));
    for (const change of applied) {
      const itemKey = `${change.type} ${change.id}`;
      hashes.set(itemKey, itemHash(change.type, byKey.has(itemKey) ? byKey.get(itemKey).value : null));
    }
    // This device's changes: what differs from the last synced value, and what was removed.
    const outgoing = [];
    const exported = new Set();
    for (const item of sendLocal ? current : []) {
      const itemKey = item.key;
      exported.add(itemKey);
      const value = item.value;
      const retained = state.get(itemKey);
      if (retained && records.read(retained).status !== "ok") {
        // Keep newer/opaque wire state byte-for-byte in sync_items. A local
        // edit cannot downgrade its schema or claim an unsupported ack; it
        // stays in the local producer until an upgraded client reconciles it.
        continue;
      }
      if (hashes.get(itemKey) === itemHash(item.type, value)) {
        // Own immutable log files vanished: restore original causal records
        // with their original HLC instead of inventing a newer watched event.
        const old = before.get(itemKey);
        if (resetOwnFiles && old && !touched.has(itemKey) && parseStamp(old.at)?.device === settings.device)
          outgoing.push(old);
        continue;
      }
      // Preserve this projection's new full hash locally without issuing a new
      // watched/progress event. Otherwise a title-only edit would publish a
      // fabricated, newer watch intent (and override a genuine remote unwatch).
      if (contextOnlyPlaybackDifference(item.type, value, state.get(itemKey))) {
        hashes.set(itemKey, itemHash(item.type, value));
        rehashed.add(itemKey);
        continue;
      }
      const authored = value.updatedAt ? { ...value, updatedBy: settings.device } : value;
      // A too-large title remains pending. Removing episodes here silently
      // loses chapter/file identity on every other device.
      const change = records.make({ type: item.type, id: item.id, value: authored,
        at: clock.tick(), previous: state.get(itemKey) });
      outgoing.push(change);
      state.set(itemKey, change);
      hashes.set(itemKey, itemHash(item.type, value));
      touched.add(itemKey);
    }
    for (const [itemKey, change] of sendLocal ? state : []) {
      if (!local.types.includes(change.type) || change.value === null || exported.has(itemKey) || !hashes.has(itemKey)
        || records.read(change).status !== "ok") continue;
      const removal = records.make({ type: change.type, id: change.id, value: null, at: clock.tick() });
      outgoing.push(removal);
      state.set(itemKey, removal);
      hashes.set(itemKey, hashOf(null));
      touched.add(itemKey);
    }
    // A repository reset can have cleared the acknowledged item table under
    // a durable preapply journal. If the user removes a locally present item
    // after that admission, there is no former state row from which the normal
    // removal loop can build a tombstone. Keep that explicit user intent in
    // the append-only log so a later peer snapshot cannot resurrect it.
    for (const [itemKey, value] of intervening) {
      if (value !== null || state.has(itemKey)) continue;
      const separator = itemKey.indexOf(" ");
      if (separator < 1) continue;
      const type = itemKey.slice(0, separator), id = itemKey.slice(separator + 1);
      if (!local.types.includes(type)) continue;
      const removal = records.make({ type, id, value: null, at: clock.tick() });
      outgoing.push(removal);
      state.set(itemKey, removal);
      hashes.set(itemKey, hashOf(null));
      touched.add(itemKey);
    }
    const keys = new Set([...touched, ...rehashed,
      ...[...state.keys()].filter((itemKey) => state.get(itemKey) !== before.get(itemKey)),
      ...[...applied].map((change) => `${change.type} ${change.id}`)]);
    // Stable subject-first ordering keeps v1 files readable and ensures a title
    // reaches old readers before its individual chapter/progress records.
    const rank = { "video.title": 0, "video.watched": 1, "video.imported-watched": 2,
      "video.progress": 3, "comic.repository": 4, "comic.favorite": 5, "comic.library": 6,
      "comic.source": 7, "comic.choice": 8, "comic.read": 9 };
    outgoing.sort((a, b) => (rank[a.type] ?? 20) - (rank[b.type] ?? 20)
      || a.id.localeCompare(b.id) || a.type.localeCompare(b.type));
    // A local author also needs to see their *own* accepted watch action on
    // all currently verified sources. Without this, another device receives
    // the right mirrored state but the author retains only their original
    // torrent's mark until an unrelated remote change arrives. Reuse exactly
    // the HLC events already prepared for publication; replicas are excluded
    // from local.export(), so this creates no second outgoing watch event.
    const authoredWatch = outgoing.filter((item) =>
      item.type === "video.watched" || item.type === "video.imported-watched");
    if (authoredWatch.length) {
      assertEpoch(epoch);
      local.apply(authoredWatch, before, {
        onLibraryApplied: (result) => journal.recordAppliedLibrary(operationId, result, localProjection),
        applyOtherAtomically: (apply) => journal.applyAndRecord(operationId, apply, localProjection),
      });
    }
    const plan = { phase: "prepared", schema: 1, operationId, scope: scope(), startedAt, full: checkedFull,
      baseCheckpoint: restoring ? prior.baseCheckpoint : baseCheckpoint,
      remoteChanged, remoteHead: head?.version || null, mark, sendLocal,
      state: [...state], updates: [...(resetOwnFiles ? state.keys() : keys)].filter((itemKey) => state.has(itemKey)).map((itemKey) =>
        [itemKey, JSON.stringify(state.get(itemKey)), hashes.get(itemKey) || null]),
      outgoing,
      // Prepared content proofs survive network interruptions. Never take a
      // fresh post-publication snapshot, which could conceal a same-ms local
      // edit that occurred while the GitHub push was in flight.
      causalProjections: outgoing.filter(change => change.type.startsWith("comic.") || change.type === "rating.lvl"
        || change.type === "rating.imported").map(change => {
        const itemKey = `${change.type} ${change.id}`;
        return [itemKey, byKey.get(itemKey)?.value ?? null];
      }),
      nextChunk: 0, seq: resetOwnFiles ? pulled.nextSeq : Math.max(pulled.nextSeq, settings.nextSeq || 1),
      resetOwnFiles, deferredPaths: pulled.deferred || [],
      seen: { ...pulled.seen }, snapshotVersion: resetOwnFiles ? null : settings.snapshotVersion || null,
      received: applied.size, appliedVideo: [...applied].filter((change) => change.type.startsWith("video.")).length,
      skipped: pulled.skipped, refused: pulled.changes.filter((change) => records.read(change).status === "invalid").length,
      clock: clock.last() };
    journal.save(plan, plan.baseCheckpoint);
    return publishPrepared(plan, syncLog, epoch);
  }

  // Every 5 s: send local edits, or ask GitHub for news when the remote check is due.
  const pendingProgressOnly = () => {
    const { state, hashes } = loadItems();
    const values = local.export();
    let changed = 0;
    const exported = new Set();
    for (const item of values) {
      const itemKey = `${item.type} ${item.id}`;
      exported.add(itemKey);
      const value = records.clean(item.type, item.value);
      if (hashes.get(itemKey) === itemHash(item.type, value)
        || contextOnlyPlaybackDifference(item.type, value, state.get(itemKey))) continue;
      if (item.type !== "video.progress" || value.finished === true || value.positionMs === 0) return false;
      changed++;
    }
    for (const [itemKey, change] of state) {
      if (local.types.includes(change.type) && change.value !== null
        && hashes.has(itemKey) && !exported.has(itemKey)) return false;
    }
    return changed > 0;
  };
  async function tick() {
    if (stopped || closing || step() !== "ready" || running) return null;
    const t = now();
    if (t < retryAt) return null;
    let mark = null;
    try { mark = local.mark?.() ?? null; } catch { mark = null; }
    if (t - lastFullAt >= FULL_EVERY_MS) return syncNow({ full: true }).catch(() => null);
    if (progressDeadline && t >= progressDeadline) return syncNow({ full: false, compareLocal: true }).catch(() => null);
    if (mark !== null && mark !== comparedMark) {
      if (!pendingProgressOnly()) {
        progressDeadline = 0;
        return syncNow({ full: false, compareLocal: true }).catch(() => null);
      }
      if (!progressDeadline) progressDeadline = t + PROGRESS_BATCH_MS;
    }
    if (t - lastRemoteAt >= REMOTE_EVERY_MS) return syncNow({ full: false, compareLocal: false }).catch(() => null);
    return null;
  }

  function schedule(ms = CHECK_EVERY_MS) {
    timers.clearTimeout(timer);
    if (stopped || closing) return;
    timer = timers.setTimeout(() => { void tick().catch(() => null).finally(() => { if (!stopped && step() === "ready") schedule(); }); }, ms);
    timer.unref?.();
  }

  // "Sync now", start and the 10-minute comparison are full; the tick's checks aren't.
  async function syncNow({ full = true, compareLocal = true } = {}) {
    if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { code: "sync_stopped", status: 409 });
    // A manual full send must not be swallowed by an already-running, remote-only poll.
    if (running) {
      if ((full && !runningOptions.full) || (compareLocal && !runningOptions.compareLocal))
        return running.catch(() => null).then(() => syncNow({ full, compareLocal }));
      return running;
    }
    if (now() < retryAt && lastError && rateLimited)
      throw Object.assign(new Error("GitHub is rate limited; retry after the reported cooldown"), { code: "rate-limited", retryAt });
    const launchedEpoch = accountEpoch;
    runningOptions = { full, compareLocal };
    const task = syncOnce({ full, compareLocal }).then((result) => {
      if (!stopped && launchedEpoch === accountEpoch) { lastError = ""; retryAt = 0; rateLimited = false; }
      return result;
    }, (error) => {
      if (!stopped && launchedEpoch === accountEpoch) {
        lastError = String(error.message || error).slice(0, 300);
        rateLimited = error.code === "rate-limited";
        retryAt = now() + (rateLimited
          ? Math.max(RETRY_MS, Math.min(MAX_RETRY_MS, Number(error.retryAfterMs) || RATE_LIMITED_RETRY_MS)) : RETRY_MS);
        if (error.code === "signed-out") {
          const before = { ...settings };
          settings.token = "";
          try { saveCredentials(); } catch (saveError) { settings = before; throw saveError; }
        }
        log.warn?.("Sync:", lastError);
      }
      throw error;
    });
    const inFlight = task.finally(() => {
      if (running === inFlight) { running = null; runningOptions = null; }
    });
    running = inFlight;
    return running;
  }

  function scheduleDevicePoll(flow) {
    if (stopped || closing || device !== flow || flow.generation !== authGeneration) return;
    const remaining = flow.expiresAt - now();
    if (remaining <= 0) {
      lastError = "The GitHub sign-in code expired; start sign-in again";
      device = null;
      authGeneration++;
      return;
    }
    flow.timer = timers.setTimeout(() => {
      void pollDevice().catch((error) => {
        if (stopped || device !== flow || flow.generation !== authGeneration) return;
        lastError = String(error.message || error).slice(0, 300);
        device = null;
        authGeneration++;
      });
    }, Math.min(flow.interval * 1000, remaining));
    flow.timer.unref?.();
  }

  async function pollDevice() {
    if (!device) return;
    const flow = device;
    if (now() >= flow.expiresAt) { scheduleDevicePoll(flow); return; }
    let answer;
    try { answer = await github.pollDevice({ clientId: app.clientId, deviceCode: flow.deviceCode }); } catch (error) {
      if (stopped || device !== flow || flow.generation !== authGeneration) return;
      lastError = String(error.message || error).slice(0, 300);
      scheduleDevicePoll(flow);
      return;
    }
    if (stopped || device !== flow || flow.generation !== authGeneration) return;
    if (answer.access_token) {
      let user = null;
      try { user = await github.user(answer.access_token); } catch {
        if (device === flow) { lastError = "Couldn't verify the GitHub account; sign in again"; device = null; authGeneration++; }
        return;
      }
      // Looking up the account is asynchronous too; cancelling/restarting must win.
      if (stopped || device !== flow || flow.generation !== authGeneration) return;
      if ((settings.active || journal.load()) && !accountMatches(user)) {
        lastError = "Reconnect with the original GitHub account to recover its pending sync";
        device = null;
        authGeneration++;
        return;
      }
      const old = { ...settings };
      accountEpoch++;
      try {
        discardUnactivatedForeignRepo(user);
        keepToken(answer, { renew: Boolean(answer.refresh_token), login: user.login,
          accountId: Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0 ? Number(user.id) : null, mode: "app" });
      } catch (error) { settings = old; accountEpoch++; throw error; }
      device = null;
      authGeneration++;
      return;
    }
    if (answer.error === "slow_down") flow.interval += 5;
    if (answer.error === "authorization_pending" || answer.error === "slow_down") {
      lastError = "";
      scheduleDevicePoll(flow);
      return;
    }
    lastError = answer.error === "access_denied" ? "The sign-in was cancelled on GitHub" : answer.error === "expired_token" ? "The code expired; sign in again" : (answer.error_description || "The sign-in didn't finish");
    device = null;
    authGeneration++;
  }

  return {
    status() {
      const shown = reloadNeeded;
      return {
        step: step(), appReady: Boolean(app.clientId), installUrl: app.slug ? `https://github.com/apps/${app.slug}/installations/new` : "",
        newRepoUrl: `https://github.com/new?name=${encodeURIComponent(repoName)}&visibility=private&description=LVL%20sync`,
        login: settings.login || "", renew: Boolean(settings.renew), mode: settings.mode || "app",
        repo: settings.repo ? `${settings.repo.owner}/${settings.repo.name}` : "", joining: Boolean(settings.joining), encrypted: Boolean(settings.encrypted),
        device: device ? { userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt } : null,
        syncing: Boolean(running), lastSyncAt: settings.lastSyncAt || 0, lastCheckedAt: Math.max(settings.lastSyncAt || 0, lastCheckAt), lastError, sent: settings.sent || 0, received: settings.received || 0,
        retryAt: rateLimited ? retryAt : 0,
        skippedFiles: settings.skippedFiles || 0, refused: settings.refused || 0, repoMissing,
        recovery: settings.active && !settings.token ? pendingRecovery() : null,
        archivedRecoveries: listArchives(),
        canResumeArchived: !settings.active && !settings.repo && !settings.token && !journal.load() && !running,
        reloadNeeded: shown,
      };
    },
    acknowledgeReload() { reloadNeeded = 0; },
    pendingRecovery,
    archivedRecoveries: listArchives,
    resumeArchived({ id } = {}) {
      requireIdle();
      if (settings.active || settings.repo || settings.token)
        throw Object.assign(new Error('Disconnect the current sync before recovering an archived one'), { status: 409 });
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))
        throw Object.assign(new Error('Select a valid local recovery archive'), { status: 400 });
      const row = db.prepare('SELECT backup_json FROM sync_recovery_archive WHERE id=?').get(id);
      if (!row) throw Object.assign(new Error('Recovery archive not found'), { status: 404 });
      const backup = JSON.parse(row.backup_json);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM sync_items');
        for (const item of backup.items) putItem.run(item.item_key, item.change_json, item.local_hash);
        db.exec('DELETE FROM sync_journal');
        if (backup.operation) db.prepare('INSERT INTO sync_journal(id, operation_json) VALUES (1, ?)').run(JSON.stringify(backup.operation));
        writeCheckpointLocked(JSON.stringify(backup.settings));
        db.prepare('DELETE FROM sync_recovery_archive WHERE id=?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      settings = backup.settings;
      accountEpoch++; authGeneration++; storageCache = null; comparedMark = null;
      return this.status();
    },
    async startDevice({ renew = true, replace = false } = {}) {
      if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { status: 409 });
      if (!app.clientId) throw Object.assign(new Error("LVL's GitHub App isn't set up in this build"), { status: 503 });
      // Two requests for the SAME still-pending connection share one GitHub
      // device-code request. Distinct renew/owner intent or explicit replace
      // deliberately starts a new generation. Never share an already-issued
      // code: a fresh Start after issuance is a new user authorization flow.
      const requestedRenew = renew !== false;
      const target = [accountEpoch, scope(), settings.accountId || "", settings.login || "",
        settings.mode || ""].join("\u0000");
      if (replace !== true && startingDevice?.generation === authGeneration
        && startingDevice.renew === requestedRenew && startingDevice.target === target)
        return startingDevice.promise;
      if (settings.active && !settings.token) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
      } else requireIdle();
      const startedEpoch = accountEpoch;
      const attempt = ++authGeneration;
      if (device?.timer) timers.clearTimeout(device.timer);
      device = null;
      const promise = (async () => {
        const answer = await github.startDevice({ clientId: app.clientId, renew: requestedRenew });
        if (stopped || closing || attempt !== authGeneration || startedEpoch !== accountEpoch)
          throw Object.assign(new Error("Sign-in was cancelled while GitHub was responding"), { code: "sync_auth_cancelled", status: 409 });
        device = { deviceCode: answer.device_code, userCode: answer.user_code, verificationUri: answer.verification_uri,
          generation: attempt, interval: Number(answer.interval) || 5, expiresAt: now() + (Number(answer.expires_in) || 900) * 1000 };
        settings.mode = "app";
        lastError = "";
        scheduleDevicePoll(device);
        return this.status();
      })();
      startingDevice = { generation: attempt, renew: requestedRenew, target, promise };
      try { return await promise; }
      finally { if (startingDevice?.promise === promise) startingDevice = null; }
    },
    cancelDevice() {
      authGeneration++;
      startingDevice = null;
      if (device?.timer) timers.clearTimeout(device.timer);
      device = null;
    },
    // A fine-grained personal access token limited to one repository (Contents: read and write).
    async useToken({ token }) {
      if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { status: 409 });
      if (!/^[\w-]{20,255}$/.test(String(token || ""))) throw Object.assign(new Error("That doesn't look like a GitHub token"), { status: 400 });
      const recovering = Boolean(settings.active && !settings.token);
      if (settings.active && !recovering) throw Object.assign(new Error("Disconnect the current sync before switching GitHub accounts"), { status: 409 });
      if (recovering) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
        const pending = journal.load();
        if (pending && pending.scope !== scope()) throw new Error("Pending sync belongs to another repository");
      } else requireIdle();
      const originalEpoch = accountEpoch;
      const attempt = ++authGeneration;
      const user = await github.user(token);
      if (stopped || attempt !== authGeneration || originalEpoch !== accountEpoch) throw new Error("GitHub account changed during sign-in");
      if (recovering) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
        if (!accountMatches(user)) throw rejectAccount();
      } else requireIdle();
      accountEpoch++;
      const previous = { ...settings };
      const previousCache = storageCache;
      const previousHead = lastObservedHead;
      try {
        discardUnactivatedForeignRepo(user);
        Object.assign(settings, { token, refreshToken: "", expiresAt: 0, renew: false, mode: "token", login: user.login || "",
          accountId: Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0 ? Number(user.id) : null });
        storageCache = null;
        lastObservedHead = null;
        saveCredentials();
      } catch (error) {
        settings = previous;
        storageCache = previousCache;
        lastObservedHead = previousHead;
        throw error;
      }
      return this.status();
    },
    // Only a repository named lvl-sync, never another one of the account (some are public).
    async findRepo() {
      if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { status: 409 });
      if (!settings.token) throw Object.assign(new Error("Sign in first"), { status: 400 });
      if (settings.active) return this.status();
      requireIdle();
      const originalEpoch = accountEpoch;
      const repos = await github.repositories(settings.token, { app: settings.mode !== "token" });
      setupAlive(originalEpoch);
      requireIdle();
      const found = repos.find((repo) => repo.name.toLowerCase() === repoName.toLowerCase());
      if (!found) { repoMissing = true; return this.status(); }
      if (!found.private) throw Object.assign(new Error(`${found.owner}/${found.name} is public. Make it private on GitHub first (Settings › Danger Zone › Change visibility)`), { status: 400 });
      // Reading the remote candidate can be slow. Keep the current account
      // untouched until every read completes; a concurrent sign-in must not
      // inherit a repository selected with the earlier account's token.
      const candidate = { owner: found.owner, name: found.name };
      const token = settings.token;
      const lookupStorage = github.storage({ token: () => token, owner: candidate.owner, repo: candidate.name });
      const existing = (await lookupStorage.list()).find((file) => file.path === SETTINGS_FILE);
      setupAlive(originalEpoch);
      requireIdle();
      let remote = null;
      if (existing) {
        remote = readSettingsFile(await lookupStorage.read(SETTINGS_FILE, existing.version));
        setupAlive(originalEpoch);
        requireIdle();
      }
      settings.repo = candidate;
      storageCache = { key: `${candidate.owner}/${candidate.name}`, token, storage: lookupStorage };
      lastObservedHead = null;
      repoMissing = false;
      settings.joining = Boolean(existing);
      settings.encrypted = remote ? (remote.encrypted ?? Boolean(remote.kdf)) : false;
      accountEpoch++;
      if (existing) {
        // Another device already syncs here without a passphrase: this device joins at once.
        if (!settings.encrypted) activate(null);
      }
      save();
      return this.status();
    },
    // A new sync in lvl-sync: plain by default; with encrypt, the files are encrypted with the passphrase.
    async startSync({ encrypt = false, passphrase = "" } = {}) {
      if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { status: 409 });
      if (!settings.repo) throw Object.assign(new Error("Find the repository first"), { status: 400 });
      if (settings.active || settings.joining) throw Object.assign(new Error("Sync is already configured; use the appropriate join step"), { status: 409 });
      requireIdle();
      const startedEpoch = accountEpoch;
      const storage = storageFor();
      const files = await storage.list();
      setupAlive(startedEpoch);
      if (files.some((file) => file.path === SETTINGS_FILE)) return this.findRepo();
      requireIdle();
      let bytes = null;
      let kdfUsed = null;
      try {
        if (encrypt) {
          const kdf = newKdfSettings();
          kdfUsed = kdf;
          bytes = await deriveKeyBytes(passphrase, kdf);
          setupAlive(startedEpoch);
          const text = await newSettingsFile({ key: await importKeyBytes(bytes), kdf });
          setupAlive(startedEpoch);
          await storage.write(SETTINGS_FILE, text, {});
        } else {
          const text = await newSettingsFile();
          setupAlive(startedEpoch);
          await storage.write(SETTINGS_FILE, text, {});
        }
      } catch (error) {
        // Another device started the sync at the same moment: join that one.
        if (error.code === "conflict") { setupAlive(startedEpoch); return this.findRepo(); }
        throw error;
      }
      setupAlive(startedEpoch);
      activate(bytes, { encrypted: Boolean(encrypt), kdf: kdfUsed });
      return this.status();
    },
    // Joining a sync another device encrypted.
    async setPassphrase({ passphrase }) {
      requireJoiningEncrypted();
      if (stopped || closing) throw Object.assign(new Error("Sync service stopped"), { status: 409 });
      requireIdle();
      const startedEpoch = accountEpoch;
      const storage = storageFor();
      const existing = (await storage.list()).find((file) => file.path === SETTINGS_FILE);
      setupAlive(startedEpoch);
      if (!existing) throw Object.assign(new Error("The encrypted sync was removed; find the repository again"), { status: 409 });
      const remote = readSettingsFile(await storage.read(SETTINGS_FILE, existing.version));
      setupAlive(startedEpoch);
      if (!remote.encrypted || !remote.kdf || !remote.check)
        throw Object.assign(new Error("The repository does not contain a valid encrypted sync"), { status: 409 });
      const bytes = await deriveKeyBytes(passphrase, remote.kdf, { existing: true });
      setupAlive(startedEpoch);
      requireIdle();
      if (!(await passphraseMatches(await importKeyBytes(bytes), remote.check)))
        throw Object.assign(new Error("That passphrase doesn't match the one used on your other devices"), { status: 400 });
      setupAlive(startedEpoch);
      activate(bytes, { kdf: remote.kdf, encrypted: true });
      return this.status();
    },
    syncNow,
    // The timer's step (tests call it with their own clock).
    tick,
    disconnect({ pending = 'reject' } = {}) {
      if (running) throw Object.assign(new Error('Sync is still in progress'), { status: 409 });
      const preview = pendingRecovery();
      if (preview.pending && pending !== 'archive')
        throw Object.assign(new Error('Pending edits require an explicit archive decision before disconnecting'),
          { status: 409, code: 'sync_pending', recovery: preview });
      const operation = journal.load();
      const items = db.prepare('SELECT item_key, change_json, local_hash FROM sync_items').all();
      const retained = { ...settings, token: '', refreshToken: '', expiresAt: 0 };
      const archive = { settings: retained, items,
        operation: operation ? { ...operation, baseCheckpoint: JSON.stringify(retained) } : null };
      const next = { device: settings.device, clock: settings.clock };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (preview.pending) db.prepare('INSERT INTO sync_recovery_archive(id, created_at, scope, backup_json) VALUES (?, ?, ?, ?)')
          .run(crypto.randomUUID(), now(), scope(), JSON.stringify(archive));
        journal.clear();
        db.exec('DELETE FROM sync_items');
        writeCheckpointLocked(JSON.stringify(next));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      this.cancelDevice();
      timers.clearTimeout(timer);
      accountEpoch++;
      settings = next;
      comparedMark = null;
      storageCache = null;
      lastObservedHead = null;
      progressDeadline = 0;
      retryAt = 0;
      rateLimited = false;
      lastCheckAt = 0;
      lastError = "";
      return this.status();
    },
    start() {
      if (closing && !stopped)
        throw Object.assign(new Error('Sync shutdown is still draining'), { code: 'sync_stopping', status: 409 });
      if (stopped) { accountEpoch++; authGeneration++; }
      closing = false; stopped = false;
      if (step() === 'ready') schedule(5000);
    },
    // LVL is closing: within a 1.5 s cooperative drain window, wait for an
    // incoming-only poll before flushing the local mark it has not acknowledged.
    // A hung network operation is not proof of durable remote delivery.
    async stop() {
      if (stopPromise) return stopPromise;
      if (stopped) return;
      closing = true;
      timers.clearTimeout(timer);
      this.cancelDevice();
      const beganAt = performance.now();
      const captured = running;
      // Shutdown's timer must be real time even when the regular scheduler is
      // injected with a deterministic test clock. The entire drain shares one
      // budget, so a cooperative poll cannot add another 1.5 s for flushing.
      const withinBudget = async (task) => {
        const remaining = Math.max(0, 1500 - (performance.now() - beganAt));
        if (!remaining) return false;
        let timeout;
        try {
          return await Promise.race([
            Promise.resolve(task).then(() => true, () => true),
            new Promise(resolve => { timeout = setTimeout(() => resolve(false), remaining); }),
          ]);
        } finally { clearTimeout(timeout); }
      };
      stopPromise = (async () => {
        try {
          // Let a captured incoming-only poll finish before checking the local
          // mark. It never acknowledged the pending playhead's upload.
          if (captured && !(await withinBudget(captured))) return;
          if (step() !== 'ready') return;
          let mark = null;
          try { mark = local.mark?.() ?? null; } catch {}
          if (mark !== null && mark !== comparedMark)
            await withinBudget(syncOnce({ full: false, compareLocal: true }).catch(() => null));
        } finally {
          // A response arriving after the deadline cannot apply locally or
          // acknowledge a publication; its journal remains for the next start.
          stopped = true;
          accountEpoch++;
          timers.clearTimeout(timer);
          if (running === captured) { running = null; runningOptions = null; }
        }
      })().finally(() => { stopPromise = null; });
      return stopPromise;
    },
  };
}
