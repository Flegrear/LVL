// Sync with a private GitHub repository named lvl-sync: the setup steps and the automatic sync.
// Setup (status().step): "start" (choose renewal, sign in) -> "device" (enter the code at
// github.com/login/device) -> "repo" (LVL finds lvl-sync; the user creates it if needed)
// -> "options" (a new sync: plain files, or encrypted with a passphrase) or "passphrase"
// (joining a sync another device encrypted; joining a plain one needs no step) -> "ready".
// Then a sync runs 5 s after start, every minute, and on "Sync now".
// One sync: read new files from the repo, apply what changed elsewhere, compare LVL's data
// with what was last synced, and write this device's changes as one new file.
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
const EVERY_MS = 60_000;
const RENEW_BEFORE_MS = 5 * 60_000;
const SNAPSHOT_EVERY = 50;

const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  : JSON.stringify(value ?? null));
const hashOf = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex").slice(0, 32);

export function createSyncService({ db, getMeta, setMeta, github, local, app = {}, now = Date.now, log = console, timers = { setTimeout, clearTimeout } } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS sync_items (item_key TEXT PRIMARY KEY, change_json TEXT NOT NULL, local_hash TEXT)");
  const read = () => { try { return JSON.parse(getMeta(META_KEY) || "{}") || {}; } catch { return {}; } };
  let settings = read();
  if (!settings.device) settings.device = newDeviceId();
  const save = () => setMeta(META_KEY, JSON.stringify(settings));
  save();
  let device = null; // the device sign-in in progress
  let running = null;
  let timer = null;
  let lastError = "";
  let reloadNeeded = 0;
  let repoMissing = false;

  const step = () => {
    if (device) return "device";
    if (!settings.token) return "start";
    if (!settings.repo) return "repo";
    if (!settings.active) return settings.joining && settings.encrypted ? "passphrase" : "options";
    return "ready";
  };
  const storageFor = () => github.storage({ token: () => settings.token, owner: settings.repo.owner, repo: settings.repo.name });

  // Setup is done: from now on this device syncs (keyBytes only for an encrypted sync).
  function activate(keyBytes) {
    Object.assign(settings, { active: true, key: keyBytes ? toBase64(keyBytes) : "", seen: {}, nextSeq: 1, joining: false });
    db.exec("DELETE FROM sync_items");
    schedule(500);
  }

  async function ensureToken() {
    if (!settings.expiresAt || now() < settings.expiresAt - RENEW_BEFORE_MS) return;
    if (!settings.refreshToken) throw Object.assign(new Error("The GitHub sign-in ended; sign in again"), { code: "signed-out" });
    const answer = await github.refresh({ clientId: app.clientId, refreshToken: settings.refreshToken });
    if (!answer.access_token) throw Object.assign(new Error("The GitHub sign-in couldn't renew; sign in again"), { code: "signed-out" });
    keepToken(answer);
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

  async function syncOnce() {
    if (step() !== "ready") return { skipped: true };
    await ensureToken();
    const storage = storageFor();
    const key = settings.key ? await importKeyBytes(fromBase64(settings.key)) : null;
    const syncLog = createSyncLog({ storage, device: settings.device, key });
    const clock = createClock({ device: settings.device, last: settings.clock });
    const pulled = await syncLog.pull(settings.seen || {});
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
    const current = local.export().map((item) => ({ ...item, key: `${item.type} ${item.id}`, value: records.clean(item.type, item.value) }));
    const byKey = new Map(current.map((item) => [item.key, item]));
    for (const change of applied) {
      const itemKey = `${change.type} ${change.id}`;
      hashes.set(itemKey, hashOf(byKey.has(itemKey) ? byKey.get(itemKey).value : null));
      if (change.type.startsWith("video.")) reloadNeeded += 1;
    }
    // This device's changes: what differs from the last synced value, and what was removed.
    const outgoing = [];
    const exported = new Set();
    for (const item of current) {
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
    for (const [itemKey, change] of state) {
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
      refused: (settings.refused || 0) + pulled.changes.filter((change) => records.read(change).status === "invalid").length });
    save();
    return { sent: outgoing.length, received: applied.size, skippedFiles: pulled.skipped, refused: settings.refused };
  }

  function schedule(ms = EVERY_MS) {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { void syncNow().catch(() => {}).finally(() => schedule()); }, ms);
    timer.unref?.();
  }

  async function syncNow() {
    if (running) return running;
    running = syncOnce().then((result) => { lastError = ""; return result; }, (error) => {
      lastError = String(error.message || error).slice(0, 300);
      if (error.code === "signed-out") { settings.token = ""; save(); }
      log.warn?.("Sync:", lastError);
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  async function pollDevice() {
    if (!device) return;
    let answer;
    try { answer = await github.pollDevice({ clientId: app.clientId, deviceCode: device.deviceCode }); } catch (error) {
      device.error = error.message;
      device.timer = timers.setTimeout(() => void pollDevice(), device.interval * 1000);
      return;
    }
    if (!device) return;
    if (answer.access_token) {
      keepToken(answer);
      settings.renew = Boolean(answer.refresh_token);
      try { settings.login = (await github.user(settings.token)).login || ""; } catch {}
      device = null;
      save();
      return;
    }
    if (answer.error === "slow_down") device.interval += 5;
    if (answer.error === "authorization_pending" || answer.error === "slow_down") {
      device.timer = timers.setTimeout(() => void pollDevice(), device.interval * 1000);
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
        newRepoUrl: "https://github.com/new?name=lvl-sync&visibility=private&description=LVL%20sync",
        login: settings.login || "", renew: Boolean(settings.renew), mode: settings.mode || "app",
        repo: settings.repo ? `${settings.repo.owner}/${settings.repo.name}` : "", joining: Boolean(settings.joining), encrypted: Boolean(settings.encrypted),
        device: device ? { userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt } : null,
        syncing: Boolean(running), lastSyncAt: settings.lastSyncAt || 0, lastError, sent: settings.sent || 0, received: settings.received || 0,
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
      device.timer = timers.setTimeout(() => void pollDevice(), device.interval * 1000);
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
      const found = repos.find((repo) => repo.name.toLowerCase() === SYNC_REPO);
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
      try {
        if (encrypt) {
          const kdf = newKdfSettings();
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
      activate(bytes);
      save();
      return this.status();
    },
    syncNow,
    disconnect() {
      this.cancelDevice();
      timers.clearTimeout(timer);
      settings = { device: settings.device, clock: settings.clock };
      db.exec("DELETE FROM sync_items");
      save();
      lastError = "";
      return this.status();
    },
    start() { if (step() === "ready") schedule(5000); },
    stop() { timers.clearTimeout(timer); this.cancelDevice(); },
  };
}
