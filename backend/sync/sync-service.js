// Sync with a private GitHub repository named lvl-sync: the setup steps and the automatic sync.
// Setup (status().step): "start" (choose renewal, sign in) -> "device" (enter the code at
// github.com/login/device) -> "repo" (LVL finds lvl-sync; the user creates it if needed)
// -> "options" (a new sync: plain files, or encrypted with a passphrase) or "passphrase"
// (joining a sync another device encrypted; joining a plain one needs no step) -> "ready".
// While LVL runs (every 5 s, cheap): this device's own changes are looked for through a
// mark (section times and row counts) and sent 15 s after the last one, or within 5 minutes
// while they keep coming (watching a video saves its position all the time). Every 30 s LVL
// asks GitHub whether lvl-sync changed: one small request, answered "not changed" (304) for
// free. Everything is compared at start, every 10 minutes and on "Sync now".
// One sync: read the files that are new in the repo, apply what changed elsewhere, compare
// LVL's data with what was last synced, and write this device's changes as one new file.
// Nothing is written when nothing synced changed.
// Kept on this device (app_meta "sync"): the sign-in, the repository, the encryption key if
// the sync is encrypted (never the passphrase), the clock and which files were read.
// sync_items: the current change for every synced item, and a hash of what LVL had for it.
import crypto from "node:crypto";
import { createClock, newDeviceId } from "../../shared/sync/clock.js";
import { records } from "../../shared/sync/records.js";
import { deriveKeyBytes, fromBase64, importKeyBytes, newKdfSettings, passphraseMatches, toBase64 } from "../../shared/sync/crypto.js";
import { SETTINGS_FILE, createSyncLog, newSettingsFile, readSettingsFile } from "../../shared/sync/log.js";

const META_KEY = "sync";
const SYNC_REPO = "lvl-sync";
const CHECK_EVERY_MS = 5_000;
const QUIET_MS = 15_000;
const MAX_WAIT_MS = 5 * 60_000;
const REMOTE_EVERY_MS = 30_000;
const FULL_EVERY_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const RATE_LIMITED_RETRY_MS = 5 * 60_000;
const RENEW_BEFORE_MS = 5 * 60_000;
const SNAPSHOT_EVERY = 50;

const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  : JSON.stringify(value ?? null));
const hashOf = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex").slice(0, 32);

export function createSyncService({ db, getMeta, setMeta, github, local, app = {}, repoName = SYNC_REPO, now = Date.now, log = console, timers = { setTimeout, clearTimeout } } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS sync_items (item_key TEXT PRIMARY KEY, change_json TEXT NOT NULL, local_hash TEXT)");
  const read = () => { try { return JSON.parse(getMeta(META_KEY) || "{}") || {}; } catch { return {}; } };
  let settings = read();
  if (!settings.device) settings.device = newDeviceId();
  const save = () => setMeta(META_KEY, JSON.stringify(settings));
  save();
  let device = null; // the device sign-in in progress
  let running = null;
  let runningOptions = null;
  let timer = null;
  let lastError = "";
  let reloadNeeded = 0;
  let repoMissing = false;
  let stopped = false;
  // The checks (tick): the local mark last compared, a change seen since, and when each check last ran.
  let comparedMark = null;
  let pendingMark = null;
  let dirtySince = 0;
  let lastChangeAt = 0;
  let lastRemoteAt = 0;
  let lastFullAt = 0;
  let lastCheckAt = 0;
  let retryAt = 0;
  let storageCache = null;

  const step = () => {
    if (device) return "device";
    if (!settings.token) return "start";
    if (!settings.repo) return "repo";
    if (!settings.active) return settings.joining && settings.encrypted ? "passphrase" : "options";
    return "ready";
  };
  const storageFor = () => {
    const key = `${settings.repo.owner}/${settings.repo.name}`;
    if (storageCache?.key !== key) storageCache = { key, storage: github.storage({ token: () => settings.token, owner: settings.repo.owner, repo: settings.repo.name }) };
    return storageCache.storage;
  };

  // Setup is done: from now on this device syncs (keyBytes only for an encrypted sync).
  function activate(keyBytes) {
    Object.assign(settings, { active: true, key: keyBytes ? toBase64(keyBytes) : "", seen: {}, nextSeq: 1, joining: false, remoteHead: "" });
    db.exec("DELETE FROM sync_items");
    comparedMark = null;
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
    if (!mine.length || mine.some((path) => pulled.paths.has(path))) return;
    for (const path of mine) delete pulled.seen[path];
    pulled.nextSeq = 1;
    settings.nextSeq = 1;
    settings.snapshotVersion = undefined;
    db.exec("DELETE FROM sync_items");
    log.warn?.("Sync: lvl-sync no longer has this device's files; sending everything again");
  }

  function keepToken(answer) {
    settings.token = answer.access_token;
    settings.refreshToken = answer.refresh_token || "";
    settings.expiresAt = answer.expires_in ? now() + Number(answer.expires_in) * 1000 : 0;
    save();
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

  // full: read the repository's file list and compare all local data, whatever the marks say.
  // compareLocal: send this device's changes (false for the 30-second check for news, so a
  // video playing doesn't send its position every 30 s).
  async function syncOnce({ full = true, compareLocal = true } = {}) {
    if (step() !== "ready") return { skipped: true };
    await ensureToken();
    const storage = storageFor();
    const startedAt = now();
    // The storage's version (GitHub: the branch's commit; "not changed" costs no quota) and this device's mark.
    const head = typeof storage.head === "function" ? await storage.head() : null;
    lastRemoteAt = startedAt;
    const remoteChanged = full || !head || head.version !== settings.remoteHead;
    const mark = local.mark?.() ?? null;
    const sendLocal = full || (compareLocal && (mark === null || mark !== comparedMark));
    if (!remoteChanged && !sendLocal) {
      lastCheckAt = now();
      return { sent: 0, received: 0, skippedFiles: [], refused: settings.refused || 0, idle: true };
    }
    const key = settings.key ? await importKeyBytes(fromBase64(settings.key)) : null;
    const syncLog = createSyncLog({ storage, device: settings.device, key });
    const clock = createClock({ device: settings.device, last: settings.clock });
    const pulled = remoteChanged ? await syncLog.pull(settings.seen || {})
      : { changes: [], seen: settings.seen || {}, skipped: [], nextSeq: settings.nextSeq || 1 };
    if (pulled.paths) await recoverStorage(storage, pulled);
    for (const change of pulled.changes) clock.observe(change.at);
    const { state, hashes } = loadItems();
    const before = new Map(state);
    const arrived = records.merge(state, pulled.changes);
    const touched = new Set(arrived.map((change) => `${change.type} ${change.id}`));
    // Changes for LVL's data that couldn't be applied before (an episode before its title) are tried again.
    const toApply = [...state.entries()].filter(([itemKey, change]) => local.types.includes(change.type)
      && (touched.has(itemKey) || !hashes.has(itemKey))).map(([, change]) => change);
    const applied = toApply.length ? local.apply(toApply, before) : new Set();
    // What LVL has now, after applying. A received item counts as in sync with its local form
    // (LVL may add its own fields, like when it was added), so it isn't sent back.
    const current = sendLocal || applied.size ? local.export().map((item) => ({ ...item, key: `${item.type} ${item.id}`, value: records.clean(item.type, item.value) })) : [];
    const byKey = new Map(current.map((item) => [item.key, item]));
    for (const change of applied) {
      const itemKey = `${change.type} ${change.id}`;
      hashes.set(itemKey, hashOf(byKey.has(itemKey) ? byKey.get(itemKey).value : null));
      if (change.type.startsWith("video.")) reloadNeeded += 1;
    }
    // This device's changes: what differs from the last synced value, and what was removed.
    const outgoing = [];
    const exported = new Set();
    for (const item of sendLocal ? current : []) {
      const itemKey = item.key;
      exported.add(itemKey);
      const value = item.value;
      if (hashes.get(itemKey) === hashOf(value)) continue;
      let change;
      try { change = records.make({ type: item.type, id: item.id, value, at: clock.tick(), previous: state.get(itemKey) }); } catch (error) {
        if (!/too large/.test(error.message) || !("episodes" in value)) throw error;
        const { episodes, ...smaller } = value;
        change = records.make({ type: item.type, id: item.id, value: smaller, at: clock.tick(), previous: state.get(itemKey) });
      }
      outgoing.push(change);
      state.set(itemKey, change);
      hashes.set(itemKey, hashOf(value));
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
    const seen = { ...pulled.seen };
    let seq = Math.max(pulled.nextSeq, settings.nextSeq || 1);
    // Up to 2000 changes per file, so a first sync of a big Library is several small files.
    for (let at = 0; at < outgoing.length; at += 2000) {
      const pushed = await syncLog.push(outgoing.slice(at, at + 2000), seq);
      seen[pushed.path] = pushed.version;
      if (seq % SNAPSHOT_EVERY === 0) settings.snapshotVersion = await syncLog.snapshot([...state.values()], seq, settings.snapshotVersion);
      seq += 1;
    }
    for (const itemKey of new Set([...touched, ...[...state.keys()].filter((k) => state.get(k) !== before.get(k))]))
      putItem.run(itemKey, JSON.stringify(state.get(itemKey)), hashes.get(itemKey) || null);
    for (const change of applied) putItem.run(`${change.type} ${change.id}`, JSON.stringify(state.get(`${change.type} ${change.id}`)), hashes.get(`${change.type} ${change.id}`));
    Object.assign(settings, { seen, nextSeq: seq, clock: clock.last(), lastSyncAt: now(), sent: (settings.sent || 0) + outgoing.length,
      received: (settings.received || 0) + applied.size,
      skippedFiles: (settings.skippedFiles || 0) + pulled.skipped.length,
      refused: (settings.refused || 0) + pulled.changes.filter((change) => records.read(change).status === "invalid").length,
      // The version seen before reading: a file another device wrote since is read next time.
      ...(remoteChanged && head ? { remoteHead: head.version } : {}) });
    save();
    lastCheckAt = now();
    if (sendLocal) { comparedMark = mark; pendingMark = null; dirtySince = 0; }
    if (full) lastFullAt = startedAt;
    return { sent: outgoing.length, received: applied.size, skippedFiles: pulled.skipped, refused: settings.refused };
  }

  // Every 5 s: has this device changed (sent after a quiet moment, or within 5 minutes while
  // changes keep coming), is it time to ask GitHub for news, or for the full comparison?
  async function tick() {
    if (step() !== "ready" || running) return null;
    const t = now();
    if (t < retryAt) return null;
    let mark = null;
    try { mark = local.mark?.() ?? null; } catch { mark = null; }
    if (mark !== null && mark !== comparedMark) {
      if (mark !== pendingMark) { pendingMark = mark; lastChangeAt = t; if (!dirtySince) dirtySince = t; }
    } else { pendingMark = null; dirtySince = 0; }
    if (t - lastFullAt >= FULL_EVERY_MS) return syncNow({ full: true }).catch(() => null);
    if (dirtySince && (t - lastChangeAt >= QUIET_MS || t - dirtySince >= MAX_WAIT_MS)) return syncNow({ full: false, compareLocal: true }).catch(() => null);
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
    runningOptions = { full, compareLocal };
    running = syncOnce({ full, compareLocal }).then((result) => { lastError = ""; retryAt = 0; return result; }, (error) => {
      lastError = String(error.message || error).slice(0, 300);
      retryAt = now() + (error.code === "rate-limited" ? RATE_LIMITED_RETRY_MS : RETRY_MS);
      if (error.code === "signed-out") { settings.token = ""; save(); }
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
      keepToken(answer);
      settings.renew = Boolean(answer.refresh_token);
      settings.login = login;
      device = null;
      save();
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
        skippedFiles: settings.skippedFiles || 0, refused: settings.refused || 0, repoMissing,
        reloadNeeded: shown,
      };
    },
    acknowledgeReload() { reloadNeeded = 0; },
    async startDevice({ renew = true } = {}) {
      if (!app.clientId) throw Object.assign(new Error("LVL's GitHub App isn't set up in this build"), { status: 503 });
      const answer = await github.startDevice({ clientId: app.clientId, renew });
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
      const user = await github.user(token);
      Object.assign(settings, { token, refreshToken: "", expiresAt: 0, renew: false, mode: "token", login: user.login || "" });
      save();
      return this.status();
    },
    // Only a repository named lvl-sync, never another one of the account (some are public).
    async findRepo() {
      if (!settings.token) throw Object.assign(new Error("Sign in first"), { status: 400 });
      const repos = await github.repositories(settings.token, { app: settings.mode !== "token" });
      const found = repos.find((repo) => repo.name.toLowerCase() === repoName.toLowerCase());
      if (!found) { repoMissing = true; return this.status(); }
      if (!found.private) throw Object.assign(new Error(`${found.owner}/${found.name} is public. Make it private on GitHub first (Settings › Danger Zone › Change visibility)`), { status: 400 });
      repoMissing = false;
      settings.repo = { owner: found.owner, name: found.name };
      const existing = (await storageFor().list()).find((file) => file.path === SETTINGS_FILE);
      settings.joining = Boolean(existing);
      if (existing) {
        const remote = readSettingsFile(await storageFor().read(SETTINGS_FILE, existing.version));
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
      const storage = storageFor();
      if ((await storage.list()).some((file) => file.path === SETTINGS_FILE)) return this.findRepo();
      let bytes = null;
      let kdfUsed = null;
      try {
        if (encrypt) {
          const kdf = newKdfSettings();
          kdfUsed = kdf;
          bytes = await deriveKeyBytes(passphrase, kdf);
          await storage.write(SETTINGS_FILE, await newSettingsFile({ key: await importKeyBytes(bytes), kdf }), {});
        } else {
          await storage.write(SETTINGS_FILE, await newSettingsFile(), {});
        }
      } catch (error) {
        // Another device started the sync at the same moment: join that one.
        if (error.code === "conflict") return this.findRepo();
        throw error;
      }
      settings.encrypted = Boolean(encrypt);
      if (encrypt) settings.kdf = kdfUsed;
      activate(bytes);
      save();
      return this.status();
    },
    // Joining a sync another device encrypted.
    async setPassphrase({ passphrase }) {
      if (!settings.repo) throw Object.assign(new Error("Find the repository first"), { status: 400 });
      const storage = storageFor();
      const existing = (await storage.list()).find((file) => file.path === SETTINGS_FILE);
      if (!existing) return this.startSync({ encrypt: true, passphrase });
      const remote = readSettingsFile(await storage.read(SETTINGS_FILE, existing.version));
      const bytes = await deriveKeyBytes(passphrase, remote.kdf);
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
      this.cancelDevice();
      timers.clearTimeout(timer);
      settings = { device: settings.device, clock: settings.clock };
      db.exec("DELETE FROM sync_items");
      comparedMark = null;
      lastCheckAt = 0;
      save();
      lastError = "";
      return this.status();
    },
    start() { stopped = false; if (step() === "ready") schedule(5000); },
    // LVL is closing: a change made in the last seconds is sent now, if that takes under 1.5 s.
    async stop() {
      stopped = true;
      timers.clearTimeout(timer);
      this.cancelDevice();
      if (step() !== "ready" || running) return;
      let mark = null;
      try { mark = local.mark?.() ?? null; } catch {}
      if (mark === null || mark === comparedMark) return;
      let wait = null;
      await Promise.race([syncNow({ full: false, compareLocal: true }).catch(() => null), new Promise((resolve) => { wait = timers.setTimeout(resolve, 1500); })]);
      timers.clearTimeout(wait);
    },
  };
}
