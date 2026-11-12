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
import { records } from "../../shared/sync/records.js";
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
  db.exec("CREATE TABLE IF NOT EXISTS sync_items (item_key TEXT PRIMARY KEY, change_json TEXT NOT NULL, local_hash TEXT)");
  const journal = createSyncJournal(db);
  const read = () => { try { return JSON.parse(getMeta(META_KEY) || "{}") || {}; } catch { return {}; } };
  let settings = read();
  const needsDevice = !settings.device;
  if (needsDevice) settings.device = newDeviceId();
  const save = () => setMeta(META_KEY, JSON.stringify(settings));
  if (needsDevice) save();
  let device = null; // the device sign-in in progress
  let running = null;
  let runningOptions = null;
  let timer = null;
  let lastError = "";
  let reloadNeeded = 0;
  let repoMissing = false;
  let stopped = false;
  // The local mark last compared, and when each check last ran.
  let comparedMark = null;
  let lastRemoteAt = 0;
  let lastFullAt = 0;
  let lastCheckAt = 0;
  let retryAt = 0;
  let rateLimited = false;
  let storageCache = null;
  let accountEpoch = 0;
  let lastObservedHead = null;
  let progressDeadline = 0;
  const scope = () => `${settings.device}:${settings.repo?.owner || ""}/${settings.repo?.name || ""}:${settings.encrypted ? "encrypted" : "plain"}`;
  const saveCredentials = () => {
    const previous = getMeta(META_KEY);
    const updated = JSON.stringify(settings);
    const pending = journal.load();
    if (pending) {
      if (pending.scope !== scope()) throw new Error("Cannot authorize an unfinished sync for a different repository");
      journal.rebindCheckpoint(pending.operationId, previous, updated, () => setMeta(META_KEY, updated));
    } else setMeta(META_KEY, updated);
  };
  const assertEpoch = (epoch) => {
    if (epoch !== accountEpoch || step() !== "ready")
      throw Object.assign(new Error("Sync account changed while an operation was running; the original journal was preserved"), { code: "sync_account_changed" });
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
  function activate(keyBytes) {
    requireIdle();
    accountEpoch++;
    Object.assign(settings, { active: true, key: keyBytes ? toBase64(keyBytes) : "", seen: {}, nextSeq: 1, joining: false, remoteHead: "" });
    db.exec("DELETE FROM sync_items");
    journal.clear();
    comparedMark = null;
    lastObservedHead = null;
    progressDeadline = 0;
    rateLimited = false;
    retryAt = 0;
    lastFullAt = 0;
    stopped = false;
    schedule(500);
  }

  async function ensureToken() {
    if (!settings.expiresAt || now() < settings.expiresAt - RENEW_BEFORE_MS) return;
    if (!settings.refreshToken) throw Object.assign(new Error("The GitHub sign-in ended; sign in again"), { code: "signed-out" });
    const answer = await github.refresh({ clientId: app.clientId, refreshToken: settings.refreshToken });
    if (!answer.access_token) throw Object.assign(new Error("The GitHub sign-in couldn't renew; sign in again"), { code: "signed-out" });
    keepToken(answer);
  }
  // lvl-sync was cleared or made again (the user can do that on GitHub): lvl-sync.json is
  // written again, and when this device's own files are gone too, it sends all its data
  // again, as on its first sync. Another device's files already there are read as usual.
  async function recoverStorage(storage, pulled) {
    if (!pulled.paths.has(SETTINGS_FILE)) {
      if (settings.key && !settings.kdf) throw Object.assign(new Error("lvl-sync.json is gone and this device can't write it again; disconnect and set up sync again"), { code: "set-up-again" });
      const text = settings.key ? await newSettingsFile({ key: await importKeyBytes(fromBase64(settings.key)), kdf: settings.kdf }) : await newSettingsFile();
      try { await storage.write(SETTINGS_FILE, text, {}); } catch (error) { if (error.code !== "conflict") throw error; }
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

  function keepToken(answer) {
    settings.token = answer.access_token;
    settings.refreshToken = answer.refresh_token || "";
    settings.expiresAt = answer.expires_in ? now() + Number(answer.expires_in) * 1000 : 0;
    storageCache = null;
    saveCredentials();
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
  const putItem = db.prepare(`INSERT INTO sync_items (item_key, change_json, local_hash) VALUES (?, ?, ?)
    ON CONFLICT(item_key) DO UPDATE SET change_json = excluded.change_json, local_hash = excluded.local_hash`);

  async function publishPrepared(plan, syncLog, epoch = accountEpoch) {
    assertEpoch(epoch);
    if (plan.scope !== scope()) throw new Error("An unfinished sync belongs to a different repository or device; reconnect to the original sync to recover it");
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
      lastSyncAt: now(), sent: (settings.sent || 0) + plan.outgoing.length,
      received: (settings.received || 0) + plan.received,
      skippedFiles: (settings.skippedFiles || 0) + plan.skipped.length,
      refused: (settings.refused || 0) + plan.refused,
      ...(plan.remoteChanged && plan.remoteHead ? { remoteHead: plan.remoteHead } : {}),
      ...(plan.snapshotVersion ? { snapshotVersion: plan.snapshotVersion } : {}) };
    // SQLite rolls back all item rows and the checkpoint if any individual row
    // fails. The outbox remains recoverable until that same commit deletes it.
    journal.commit(plan.operationId, () => {
      for (const [itemKey, json, hash] of plan.updates) putItem.run(itemKey, json, hash);
      setMeta(META_KEY, JSON.stringify(nextSettings));
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
    const syncLog = createSyncLog({ storage, device: settings.device, key });
    if (prior?.phase === "prepared") return publishPrepared(prior, syncLog, epoch);
    const restoring = prior?.phase === "preapply";
    const operationId = restoring ? prior.operationId : crypto.randomUUID();
    const startedAt = restoring ? prior.startedAt : now();
    // The storage's version (GitHub: the branch's commit; "not changed" costs no quota) and this device's mark.
    const head = restoring ? (prior.remoteHead ? { version: prior.remoteHead } : null)
      : typeof storage.head === "function" ? await storage.head() : null;
    assertEpoch(epoch);
    lastRemoteAt = now();
    const remoteChanged = restoring ? prior.remoteChanged : full || !head || head.version !== (lastObservedHead ?? settings.remoteHead);
    let mark = restoring ? prior.mark : local.mark?.() ?? null;
    let sendLocal = restoring ? prior.sendLocal : full || (compareLocal && (mark === null || mark !== comparedMark));
    const checkedFull = restoring ? prior.full : full;
    if (!remoteChanged && !sendLocal) {
      lastCheckAt = now();
      return { sent: 0, received: 0, skippedFiles: [], refused: settings.refused || 0, idle: true };
    }
    const clock = createClock({ device: settings.device, last: settings.clock, now });
    const pulled = restoring ? prior.pulled : remoteChanged ? await syncLog.pull(settings.seen || {})
      : { changes: [], seen: settings.seen || {}, skipped: [], nextSeq: settings.nextSeq || 1 };
    assertEpoch(epoch);
    const resetOwnFiles = restoring ? Boolean(prior.resetOwnFiles)
      : pulled.paths ? await recoverStorage(storage, pulled) : false;
    assertEpoch(epoch);
    for (const change of pulled.changes) {
      const inspected = records.read(change);
      if (inspected.status !== "invalid") clock.observe(inspected.change.at);
    }
    // Full scans must still inspect the remote tree and *actual* local hashes.
    // When nothing has changed, don't create and remove a SQLite journal just
    // to say that the repository was checked.
    if (!restoring && !resetOwnFiles && settings.hashVersion === 2
      && pulled.changes.length === 0 && stable(pulled.seen) === stable(settings.seen)) {
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
      pulled: { changes: pulled.changes, seen: pulled.seen, skipped: pulled.skipped, nextSeq: pulled.nextSeq },
      pending: [...pending], baseCheckpoint, resetOwnFiles }, baseCheckpoint, (operation) => {
        if (resetOwnFiles) db.exec("DELETE FROM sync_items");
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
    if (resetOwnFiles) {
      settings.nextSeq = 1;
      settings.snapshotVersion = undefined;
      if (!restoring) log.warn?.("Sync: lvl-sync no longer has this device's files; sending everything again");
    }
    const { state, hashes } = loadItems();
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
    const arrived = records.merge(state, pulled.changes);
    const touched = new Set(arrived.map((change) => `${change.type} ${change.id}`));
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
      && !dirty.has(itemKey)
      && !(change.type.startsWith("video.") && dirty.has(`video.title ${change.id.split("/")[0]}`)
        && !pending.has(`video.title ${change.id.split("/")[0]}`))
      && (touched.has(itemKey) || !hashes.has(itemKey) || historyToReplay.has(itemKey))).map(([, change]) => change);
    assertEpoch(epoch);
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
      if (hashes.get(itemKey) === itemHash(item.type, value)) continue;
      // Preserve this projection's new full hash locally without issuing a new
      // watched/progress event. Otherwise a title-only edit would publish a
      // fabricated, newer watch intent (and override a genuine remote unwatch).
      if (contextOnlyPlaybackDifference(item.type, value, state.get(itemKey))) {
        hashes.set(itemKey, itemHash(item.type, value));
        rehashed.add(itemKey);
        continue;
      }
      const authored = value.updatedAt ? { ...value, updatedBy: settings.device } : value;
      let change;
      try { change = records.make({ type: item.type, id: item.id, value: authored, at: clock.tick(), previous: state.get(itemKey) }); } catch (error) {
        if (!/too large/.test(error.message) || !("episodes" in value)) throw error;
        const { episodes, ...smaller } = value;
        change = records.make({ type: item.type, id: item.id, value: smaller, at: clock.tick(), previous: state.get(itemKey) });
      }
      outgoing.push(change);
      state.set(itemKey, change);
      hashes.set(itemKey, itemHash(item.type, value));
      touched.add(itemKey);
    }
    for (const [itemKey, change] of sendLocal ? state : []) {
      if (!local.types.includes(change.type) || change.value === null || exported.has(itemKey) || !hashes.has(itemKey)) continue;
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
      state: [...state], updates: [...keys].filter((itemKey) => state.has(itemKey)).map((itemKey) =>
        [itemKey, JSON.stringify(state.get(itemKey)), hashes.get(itemKey) || null]),
      outgoing, nextChunk: 0, seq: Math.max(pulled.nextSeq, settings.nextSeq || 1),
      seen: { ...pulled.seen }, snapshotVersion: settings.snapshotVersion || null,
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
    if (step() !== "ready" || running) return null;
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
    if (stopped) return;
    timer = timers.setTimeout(() => { void tick().catch(() => null).finally(() => { if (!stopped && step() === "ready") schedule(); }); }, ms);
    timer.unref?.();
  }

  // "Sync now", start and the 10-minute comparison are full; the tick's checks aren't.
  async function syncNow({ full = true, compareLocal = true } = {}) {
    // A manual full send must not be swallowed by an already-running, remote-only poll.
    if (running) {
      if ((full && !runningOptions.full) || (compareLocal && !runningOptions.compareLocal))
        return running.catch(() => null).then(() => syncNow({ full, compareLocal }));
      return running;
    }
    if (now() < retryAt && lastError && rateLimited)
      throw Object.assign(new Error("GitHub is rate limited; retry after the reported cooldown"), { code: "rate-limited", retryAt });
    runningOptions = { full, compareLocal };
    running = syncOnce({ full, compareLocal }).then((result) => { lastError = ""; retryAt = 0; rateLimited = false; return result; }, (error) => {
      lastError = String(error.message || error).slice(0, 300);
      rateLimited = error.code === "rate-limited";
      retryAt = now() + (rateLimited
        ? Math.max(RETRY_MS, Math.min(MAX_RETRY_MS, Number(error.retryAfterMs) || RATE_LIMITED_RETRY_MS)) : RETRY_MS);
      if (error.code === "signed-out") { settings.token = ""; saveCredentials(); }
      log.warn?.("Sync:", lastError);
      throw error;
    }).finally(() => { running = null; runningOptions = null; });
    return running;
  }

  function scheduleDevicePoll(flow) {
    if (device !== flow) return;
    const remaining = flow.expiresAt - now();
    if (remaining <= 0) {
      lastError = "The GitHub sign-in code expired; start sign-in again";
      device = null;
      return;
    }
    flow.timer = timers.setTimeout(() => {
      void pollDevice().catch((error) => {
        if (device !== flow) return;
        lastError = String(error.message || error).slice(0, 300);
        device = null;
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
      if (device !== flow) return;
      lastError = String(error.message || error).slice(0, 300);
      scheduleDevicePoll(flow);
      return;
    }
    if (device !== flow) return;
    if (answer.access_token) {
      let login = "";
      try { login = (await github.user(answer.access_token)).login || ""; } catch {}
      // Looking up the account is asynchronous too; cancelling/restarting must win.
      if (device !== flow) return;
      if (settings.active && !settings.token &&
        (!settings.login || login.toLowerCase() !== settings.login.toLowerCase())) {
        lastError = "Reconnect with the original GitHub account to recover its pending sync";
        device = null;
        return;
      }
      keepToken(answer);
      settings.renew = Boolean(answer.refresh_token);
      settings.login = login;
      device = null;
      saveCredentials();
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
        reloadNeeded: shown,
      };
    },
    acknowledgeReload() { reloadNeeded = 0; },
    async startDevice({ renew = true } = {}) {
      if (!app.clientId) throw Object.assign(new Error("LVL's GitHub App isn't set up in this build"), { status: 503 });
      if (settings.active && !settings.token) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
      } else requireIdle();
      const startedEpoch = accountEpoch;
      const answer = await github.startDevice({ clientId: app.clientId, renew });
      if (startedEpoch !== accountEpoch) throw new Error("Sign-in was cancelled while GitHub was responding");
      if (device?.timer) timers.clearTimeout(device.timer);
      device = { deviceCode: answer.device_code, userCode: answer.user_code, verificationUri: answer.verification_uri,
        interval: Number(answer.interval) || 5, expiresAt: now() + (Number(answer.expires_in) || 900) * 1000 };
      settings.mode = "app";
      lastError = "";
      scheduleDevicePoll(device);
      return this.status();
    },
    cancelDevice() { if (device?.timer) timers.clearTimeout(device.timer); device = null; },
    // A fine-grained personal access token limited to one repository (Contents: read and write).
    async useToken({ token }) {
      if (!/^[\w-]{20,255}$/.test(String(token || ""))) throw Object.assign(new Error("That doesn't look like a GitHub token"), { status: 400 });
      const recovering = Boolean(settings.active && !settings.token);
      if (settings.active && !recovering) throw Object.assign(new Error("Disconnect the current sync before switching GitHub accounts"), { status: 409 });
      if (recovering) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
        const pending = journal.load();
        if (pending && pending.scope !== scope()) throw new Error("Pending sync belongs to another repository");
      } else requireIdle();
      const originalEpoch = accountEpoch;
      const user = await github.user(token);
      if (originalEpoch !== accountEpoch) throw new Error("GitHub account changed during sign-in");
      if (recovering) {
        if (running) throw Object.assign(new Error("The old sync publication is still active"), { status: 409 });
        if (!settings.login || user.login?.toLowerCase() !== settings.login.toLowerCase())
          throw Object.assign(new Error("Reconnect the original GitHub account to recover its pending sync"), { status: 409 });
      } else requireIdle();
      accountEpoch++;
      Object.assign(settings, { token, refreshToken: "", expiresAt: 0, renew: false, mode: "token", login: user.login || "" });
      storageCache = null;
      lastObservedHead = null;
      saveCredentials();
      return this.status();
    },
    // Only a repository named lvl-sync, never another one of the account (some are public).
    async findRepo() {
      if (!settings.token) throw Object.assign(new Error("Sign in first"), { status: 400 });
      if (settings.active) return this.status();
      requireIdle();
      const originalEpoch = accountEpoch;
      const repos = await github.repositories(settings.token, { app: settings.mode !== "token" });
      if (originalEpoch !== accountEpoch) throw new Error("GitHub account changed during repository lookup");
      requireIdle();
      const found = repos.find((repo) => repo.name.toLowerCase() === repoName.toLowerCase());
      if (!found) { repoMissing = true; return this.status(); }
      if (!found.private) throw Object.assign(new Error(`${found.owner}/${found.name} is public. Make it private on GitHub first (Settings › Danger Zone › Change visibility)`), { status: 400 });
      repoMissing = false;
      settings.repo = { owner: found.owner, name: found.name };
      storageCache = null;
      lastObservedHead = null;
      accountEpoch++;
      const lookupEpoch = accountEpoch;
      const lookupStorage = storageFor();
      const existing = (await lookupStorage.list()).find((file) => file.path === SETTINGS_FILE);
      if (lookupEpoch !== accountEpoch) throw new Error("Repository lookup was cancelled before it finished");
      requireIdle();
      settings.joining = Boolean(existing);
      if (existing) {
        const remote = readSettingsFile(await lookupStorage.read(SETTINGS_FILE, existing.version));
        if (lookupEpoch !== accountEpoch) throw new Error("Repository lookup was cancelled before activation");
        settings.encrypted = remote.encrypted ?? Boolean(remote.kdf);
        // Another device already syncs here without a passphrase: this device joins at once.
        if (!settings.encrypted) activate(null);
      }
      save();
      return this.status();
    },
    // A new sync in lvl-sync: plain by default; with encrypt, the files are encrypted with the passphrase.
    async startSync({ encrypt = false, passphrase = "" } = {}) {
      if (!settings.repo) throw Object.assign(new Error("Find the repository first"), { status: 400 });
      requireIdle();
      const startedEpoch = accountEpoch;
      const storage = storageFor();
      if ((await storage.list()).some((file) => file.path === SETTINGS_FILE)) return this.findRepo();
      if (startedEpoch !== accountEpoch) throw new Error("Sync setup was cancelled during repository inspection");
      requireIdle();
      let bytes = null;
      let kdfUsed = null;
      try {
        if (encrypt) {
          const kdf = newKdfSettings();
          kdfUsed = kdf;
          bytes = await deriveKeyBytes(passphrase, kdf);
          if (startedEpoch !== accountEpoch) throw new Error("Sync setup was cancelled during key derivation");
          await storage.write(SETTINGS_FILE, await newSettingsFile({ key: await importKeyBytes(bytes), kdf }), {});
        } else {
          await storage.write(SETTINGS_FILE, await newSettingsFile(), {});
        }
      } catch (error) {
        // Another device started the sync at the same moment: join that one.
        if (error.code === "conflict") return this.findRepo();
        throw error;
      }
      if (startedEpoch !== accountEpoch) throw new Error("Sync setup was cancelled after remote publication");
      settings.encrypted = Boolean(encrypt);
      if (encrypt) settings.kdf = kdfUsed;
      activate(bytes);
      save();
      return this.status();
    },
    // Joining a sync another device encrypted.
    async setPassphrase({ passphrase }) {
      if (!settings.repo) throw Object.assign(new Error("Find the repository first"), { status: 400 });
      requireIdle();
      const startedEpoch = accountEpoch;
      const storage = storageFor();
      const existing = (await storage.list()).find((file) => file.path === SETTINGS_FILE);
      if (startedEpoch !== accountEpoch) throw new Error("Passphrase setup was cancelled during repository lookup");
      if (!existing) return this.startSync({ encrypt: true, passphrase });
      const remote = readSettingsFile(await storage.read(SETTINGS_FILE, existing.version));
      const bytes = await deriveKeyBytes(passphrase, remote.kdf);
      if (startedEpoch !== accountEpoch) throw new Error("Passphrase setup was cancelled before activation");
      requireIdle();
      if (!(await passphraseMatches(await importKeyBytes(bytes), remote.check)))
        throw Object.assign(new Error("That passphrase doesn't match the one used on your other devices"), { status: 400 });
      settings.kdf = remote.kdf;
      activate(bytes);
      save();
      return this.status();
    },
    syncNow,
    // The timer's step (tests call it with their own clock).
    tick,
    disconnect() {
      requireIdle();
      this.cancelDevice();
      timers.clearTimeout(timer);
      accountEpoch++;
      settings = { device: settings.device, clock: settings.clock };
      journal.clear();
      db.exec("DELETE FROM sync_items");
      comparedMark = null;
      storageCache = null;
      lastObservedHead = null;
      progressDeadline = 0;
      retryAt = 0;
      rateLimited = false;
      lastCheckAt = 0;
      save();
      lastError = "";
      return this.status();
    },
    start() { stopped = false; if (step() === "ready") schedule(5000); },
    // LVL is closing: within a 1.5 s cooperative drain window, wait for an
    // incoming-only poll before flushing the local mark it has not acknowledged.
    // A hung network operation is not proof of durable remote delivery.
    async stop() {
      stopped = true;
      timers.clearTimeout(timer);
      this.cancelDevice();
      if (step() !== "ready") return;
      const drain = async () => {
        if (running) await running.catch(() => null);
        if (step() !== "ready") return;
        let mark = null;
        try { mark = local.mark?.() ?? null; } catch {}
        if (mark === null || mark === comparedMark) return;
        await syncNow({ full: false, compareLocal: true }).catch(() => null);
      };
      let wait = null;
      await Promise.race([drain(), new Promise((resolve) => { wait = timers.setTimeout(resolve, 1500); })]);
      timers.clearTimeout(wait);
    },
  };
}
