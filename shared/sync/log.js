// The files LVL keeps in the sync storage (a GitHub repo, a Google Drive app folder, a folder):
//   lvl-sync.json                      format version, encryption settings, passphrase check
//   changes/<device>/000001.json       changes made on one device, numbered, never edited
//   snapshots/<device>.json            one device's whole view now and then, so a new device
//                                      reads a snapshot plus the later change files
// Only the device in the path writes its files, so two devices never write the same file.
// Every file except lvl-sync.json is encrypted (crypto.js), its path bound to it.
// storage: { list() -> [{ path, version }], read(path, version) -> text,
//            write(path, text, { version }) -> new version }
import { SYNC_FORMAT, SYNC_FORMAT_VERSION } from "./records.js";
import { decryptText, encryptText, makeCheck, newKdfSettings } from "./crypto.js";

export const SETTINGS_FILE = "lvl-sync.json";
const CHANGE_FILE = /^changes\/([a-z0-9][a-z0-9-]{2,31})\/(\d{6})\.json$/;
const SNAPSHOT_FILE = /^snapshots\/([a-z0-9][a-z0-9-]{2,31})\.json$/;
const MAX_CHANGES_PER_FILE = 5000;
export const changePath = (device, seq) => `changes/${device}/${String(seq).padStart(6, "0")}.json`;
export const snapshotPath = (device) => `snapshots/${device}.json`;

// lvl-sync.json for a new sync: the format, the passphrase settings and a check value.
export async function newSettingsFile(key, kdf) {
  return JSON.stringify({ format: SYNC_FORMAT, version: SYNC_FORMAT_VERSION, kdf, check: await makeCheck(key) }, null, 1);
}
export { newKdfSettings };

// Reads lvl-sync.json; a newer layout than this LVL knows stops syncing (never written over).
export function readSettingsFile(text) {
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error("lvl-sync.json isn't readable"); }
  if (settings?.format !== SYNC_FORMAT || !Number.isInteger(settings.version)) throw new Error("This storage isn't an LVL sync");
  if (settings.version > SYNC_FORMAT_VERSION)
    throw Object.assign(new Error("A newer LVL set up this sync; update LVL on this device to keep syncing"), { code: "update-lvl" });
  return settings;
}

export function createSyncLog({ storage, device, key }) {
  const readJson = async (path, version) => JSON.parse(await decryptText(key, path, await storage.read(path, version)));

  return {
    // Everything new since `seen` ({ path: version } of files already read): snapshots that
    // changed, then change files not read yet. Returns the changes, the new `seen`, and the
    // next number for this device's own change files.
    async pull(seen = {}) {
      const files = await storage.list();
      const next = { ...seen };
      const changes = [];
      let ownLast = 0;
      const snapshots = files.filter((file) => SNAPSHOT_FILE.test(file.path));
      const covered = new Map();
      for (const file of snapshots) {
        const owner = SNAPSHOT_FILE.exec(file.path)[1];
        if (seen[file.path] === file.version) continue;
        const snapshot = await readJson(file.path, file.version);
        if (Array.isArray(snapshot?.changes)) changes.push(...snapshot.changes);
        if (Number.isInteger(snapshot?.upTo)) covered.set(owner, snapshot.upTo);
        next[file.path] = file.version;
        if (owner === device) ownLast = Math.max(ownLast, snapshot?.upTo || 0);
      }
      const changeFiles = files.map((file) => ({ file, match: CHANGE_FILE.exec(file.path) })).filter((item) => item.match)
        .sort((a, b) => a.file.path.localeCompare(b.file.path));
      for (const { file, match } of changeFiles) {
        const [, owner, number] = match;
        const seq = Number(number);
        if (owner === device) ownLast = Math.max(ownLast, seq);
        if (next[file.path] || (covered.get(owner) || 0) >= seq) { next[file.path] = next[file.path] || file.version; continue; }
        const content = await readJson(file.path, file.version);
        if (Array.isArray(content?.changes)) changes.push(...content.changes);
        next[file.path] = file.version;
      }
      return { changes, seen: next, nextSeq: ownLast + 1 };
    },
    // Writes this device's next change file.
    async push(changes, seq) {
      if (!changes.length) return null;
      if (changes.length > MAX_CHANGES_PER_FILE) throw new Error("Too many changes for one sync file");
      const path = changePath(device, seq);
      const version = await storage.write(path, await encryptText(key, path, JSON.stringify({ device, seq, changes })), {});
      return { path, version };
    },
    // Replaces this device's snapshot: all current changes, up to its change file `upTo`.
    async snapshot(changes, upTo, version) {
      const path = snapshotPath(device);
      return storage.write(path, await encryptText(key, path, JSON.stringify({ device, upTo, changes })), { version });
    },
  };
}

// A storage in memory, for tests and as the reference for real storages.
export function memoryStorage() {
  const files = new Map();
  let counter = 0;
  return {
    files,
    async list() { return [...files].map(([path, file]) => ({ path, version: file.version })); },
    async read(path) {
      if (!files.has(path)) throw Object.assign(new Error(`${path} is missing`), { code: "missing" });
      return files.get(path).text;
    },
    async write(path, text, { version } = {}) {
      const current = files.get(path);
      if (current && current.version !== version) throw Object.assign(new Error(`${path} changed`), { code: "conflict" });
      if (!current && version) throw Object.assign(new Error(`${path} is missing`), { code: "conflict" });
      const file = { text, version: `v${++counter}` };
      files.set(path, file);
      return file.version;
    },
  };
}
