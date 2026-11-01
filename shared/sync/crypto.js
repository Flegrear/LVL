// Encryption of sync files, so the storage (GitHub, Google Drive, a folder) only sees file
// names and sizes. WebCrypto only, so the same code runs in Node, browsers and the phone app.
// - The key comes from the user's passphrase: PBKDF2-SHA-256, 600,000 rounds (OWASP's
//   2023 figure), a random 16-byte salt kept in lvl-sync.json. Kept with the settings, so
//   stronger settings later only need a new lvl-sync.json.
// - Each file is AES-256-GCM with a random 12-byte IV. The file's path is authenticated too,
//   so a file can't be swapped for another one.
// - lvl-sync.json holds a check value, so a wrong passphrase is told apart from damaged files.
const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error("This device can't encrypt (WebCrypto is unavailable)");
  return globalThis.crypto.subtle;
};
export const KDF_DEFAULTS = Object.freeze({ name: "PBKDF2-SHA-256", iterations: 600_000 });
const CHECK_TEXT = "lvl-sync passphrase check";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}
export function fromBase64(text) {
  const raw = atob(String(text || ""));
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

export function newKdfSettings({ iterations = KDF_DEFAULTS.iterations } = {}) {
  return { name: KDF_DEFAULTS.name, iterations, salt: toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))) };
}

export async function deriveKey(passphrase, kdf) {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("The sync passphrase must have at least 8 characters");
  if (kdf?.name !== KDF_DEFAULTS.name || !Number.isInteger(kdf.iterations) || kdf.iterations < 100_000) throw new Error("Unsupported sync encryption settings");
  const base = await subtle().importKey("raw", encoder.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt), iterations: kdf.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// file: the path inside the sync storage, like "changes/d-4k2m9x7q1z/000001.json".
export async function encryptText(key, file, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(file) }, key, encoder.encode(text)));
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(data) });
}

export async function decryptText(key, file, stored) {
  let box;
  try { box = JSON.parse(stored); } catch { throw new Error(`${file} isn't a sync file`); }
  if (box?.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") throw new Error(`${file} isn't an encrypted sync file`);
  try {
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(box.iv), additionalData: encoder.encode(file) }, key, fromBase64(box.data));
    return decoder.decode(plain);
  } catch {
    throw Object.assign(new Error(`${file} couldn't be decrypted (damaged, or moved from another file)`), { code: "decrypt-failed" });
  }
}

// The check value kept in lvl-sync.json, and its test on another device.
export const makeCheck = (key) => encryptText(key, "lvl-sync.json", CHECK_TEXT);
export async function passphraseMatches(key, check) {
  try { return (await decryptText(key, "lvl-sync.json", check)) === CHECK_TEXT; } catch { return false; }
}
