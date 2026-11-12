// The files LVL keeps in the sync storage (a GitHub repo, a Google Drive app folder, a folder):
//   lvl-sync.json                      format version, encryption settings, passphrase check
//   changes/<device>/000001.json       changes made on one device, numbered, never edited
//   snapshots/<device>.json            one device's whole view now and then, so a new device
//                                      reads a snapshot plus the later change files
// Only the device in the path writes its files, so two devices never write the same file.
// Files are plain JSON by default; with the passphrase option every file except lvl-sync.json
// is encrypted (crypto.js), its path bound to it.
// storage: { list() -> [{ path, version }], read(path, version) -> text,
//            write(path, text, { version }) -> new version,
//            head() -> { version } (optional: the whole storage's version, cheap to ask) }
import { SYNC_FORMAT, SYNC_FORMAT_VERSION } from "./records.js";
import { decryptText, encryptText, makeCheck, newKdfSettings } from "./crypto.js";

export const SETTINGS_FILE = "lvl-sync.json";
const CHANGE_FILE = /^changes\/([a-z0-9][a-z0-9-]{2,31})\/(\d{6})\.json$/;
const SNAPSHOT_FILE = /^snapshots\/([a-z0-9][a-z0-9-]{2,31})\.json$/;
const MAX_CHANGES_PER_FILE = 5000;
export const changePath = (device, seq) => `changes/${device}/${String(seq).padStart(6, "0")}.json`;
export const snapshotPath = (device) => `snapshots/${device}.json`;

// lvl-sync.json for a new sync: the format, and with a key, the passphrase settings and a check value.
export async function newSettingsFile({ key = null, kdf = null } = {}) {
  const base = { format: SYNC_FORMAT, version: SYNC_FORMAT_VERSION, encrypted: Boolean(key) };
  return JSON.stringify(key ? { ...base, kdf, check: await makeCheck(key) } : base, null, 1);
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

export function createSyncLog({ storage, device, key = null }) {
  // Keep plain records indented so fields and individual edits are readable on GitHub.
  const encode = async (path, data) => {
    if (key) return encryptText(key, path, JSON.stringify(data));
    return `${JSON.stringify(data, null, 2)}\n`;
  };
  const readJson = async (path, version) => {
    const text = await storage.read(path, version);
    return JSON.parse(key ? await decryptText(key, path, text) : text);
  };
  // A file that is damaged, from another passphrase or not LVL's is skipped (and reported),
  // so one bad file can't stop syncing; a network error still stops this sync.
  const unreadable = (error) => error?.code === "decrypt-failed" || error?.code === "not-sync-file" || error instanceof SyntaxError;

  return {
    // Everything new since `seen` ({ path: version } of files already read): snapshots that
    // changed, then change files not read yet. Returns the changes, the new `seen`, the
    // files skipped, the next number for this device's own change files, and every path listed.
    async pull(seen = {}) {
      const files = await storage.list();
      const next = { ...seen };
      const changes = [];
      const skipped = [];
      let ownLast = 0;
      // null when the file was skipped: unreadable, or readable without a list of changes.
      const tryRead = async (file) => {
        let content;
        try { content = await readJson(file.path, file.version); } catch (error) {
          if (!unreadable(error)) throw error;
        }
        if (Array.isArray(content?.changes)) return content;
        skipped.push(file.path);
        return null;
      };
      const snapshots = files.filter((file) => SNAPSHOT_FILE.test(file.path));
      const covered = new Map();
      for (const file of snapshots) {
        const owner = SNAPSHOT_FILE.exec(file.path)[1];
        if (seen[file.path] === file.version) continue;
        const snapshot = await tryRead(file);
        next[file.path] = file.version;
        if (!snapshot) continue;
        changes.push(...snapshot.changes);
        if (Number.isInteger(snapshot.upTo)) covered.set(owner, snapshot.upTo);
        if (owner === device) ownLast = Math.max(ownLast, snapshot.upTo || 0);
      }
      const changeFiles = files.map((file) => ({ file, match: CHANGE_FILE.exec(file.path) })).filter((item) => item.match)
        .sort((a, b) => a.file.path.localeCompare(b.file.path));
      for (const { file, match } of changeFiles) {
        const [, owner, number] = match;
        const seq = Number(number);
        if (owner === device) ownLast = Math.max(ownLast, seq);
        if (next[file.path] || (covered.get(owner) || 0) >= seq) { next[file.path] = next[file.path] || file.version; continue; }
        const content = await tryRead(file);
        next[file.path] = file.version;
        if (content) changes.push(...content.changes);
      }
      return { changes, seen: next, skipped, nextSeq: ownLast + 1, paths: new Set(files.map((file) => file.path)) };
    },
    // Writes this device's next change file.
    async push(changes, seq) {
      if (!changes.length) return null;
      if (changes.length > MAX_CHANGES_PER_FILE) throw new Error("Too many changes for one sync file");
      const path = changePath(device, seq);
      const planned = { device, seq, changes };
      // Serialize once: a transient branch conflict may retry this exact
      // immutable file, never invent another sequence, clock or set of changes.
      const text = await encode(path, planned);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const version = await storage.write(path, text, {});
          return { path, version };
        } catch (error) {
          if (error.code !== "conflict") throw error;
          // GitHub may have committed the file but its response was lost.
          const existing = (await storage.list()).find((file) => file.path === path);
          if (existing) {
            const content = await readJson(path, existing.version);
            if (content?.device !== device || content?.seq !== seq
              || JSON.stringify(content.changes) !== JSON.stringify(changes))
              throw Object.assign(new Error(`${path} changed on GitHub; its immutable sequence cannot be replaced`),
                { code: "sync_immutable_conflict" });
            return { path, version: existing.version, replayed: true };
          }
          if (attempt === 2) throw error;
          // The branch moved, but our path does not exist. Refresh its head
          // and allow a bounded retry without changing the payload.
          await storage.head?.();
        }
      }
    },
    // Replaces this device's snapshot: all current changes, up to its change file `upTo`.
    async snapshot(changes, upTo, version) {
      const path = snapshotPath(device);
      const planned = { device, upTo, changes };
      try { return await storage.write(path, await encode(path, planned), { version }); }
      catch (error) {
        if (error.code !== "conflict") throw error;
        const current = (await storage.list()).find((file) => file.path === path);
        if (!current) throw error;
        const content = await readJson(path, current.version);
        if (content?.device !== device || content?.upTo !== upTo
          || JSON.stringify(content.changes) !== JSON.stringify(changes)) throw error;
        return current.version;
      }
    },
  };
}

// A storage in memory, for tests and as the reference for real storages.
export function memoryStorage() {
  const files = new Map();
  let counter = 0;
  return {
    files,
    async head() { return { version: `h${counter}` }; },
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
