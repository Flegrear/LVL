// Pages of a local comic: a .cbz/.zip archive or a folder of images.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { openZip } from "./zip-reader.js";

export const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)$/i;
const MAX_FOLDER_IMAGES = 5000;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

// Natural order: "page 2" before "page 10".
export const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.toString("ascii", 4, 8) === "ftyp" && /^avi[fs]/.test(buffer.toString("ascii", 8, 12))) return "image/avif";
  return null;
}

// ComicInfo.xml (Anansi project): only the fields used for matching.
export function parseComicInfo(xml) {
  const text = String(xml || "").slice(0, 200_000);
  const tag = (name) => {
    const match = new RegExp(`<${name}>([^<]{0,500})</${name}>`, "i").exec(text);
    return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").trim() : "";
  };
  const web = tag("Web");
  const anilist = /anilist\.co\/manga\/(\d{1,9})/i.exec(web)?.[1];
  const mal = /myanimelist\.net\/manga\/(\d{1,9})/i.exec(web)?.[1];
  return {
    series: tag("Series"), title: tag("Title"), volume: tag("Volume"), number: tag("Number"),
    anilistId: anilist ? Number(anilist) : null, malId: mal ? Number(mal) : null,
  };
}

// A bounded archive-content witness. ZIP directory records include the CRC,
// compressed size and offset of every entry. Unlike size/mtime/ctime, these
// bytes change when a replaced CBZ keeps its original filesystem timestamps.
// The cap prevents a periodic library scan from reading whole multi-GB packs.
export async function archiveContentWitness(file, stat = null) {
  const handle = await fs.open(file, "r");
  try {
    // Use the opened handle's size: a concurrent replacement may have
    // occurred after the caller's preliminary stat.
    const size = Number((await handle.stat()).size);
    if (!Number.isSafeInteger(size) || size < 22) throw new Error("Invalid archive size");
    const digest = crypto.createHash("sha256").update("lvl-cbz-witness-v2\n").update(String(size));
    const read = async (at, bytes) => {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, at);
      if (bytesRead !== bytes) throw new Error("Archive changed during verification");
      return buffer;
    };
    const tailSize = Math.min(size, 65_557);
    const tail = await read(size - tailSize, tailSize);
    digest.update(tail);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("Not a ZIP archive");
    let directorySize = tail.readUInt32LE(end + 12);
    let directoryStart = tail.readUInt32LE(end + 16);
    if (directorySize === 0xffffffff || directoryStart === 0xffffffff) {
      const locator = end - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50)
        throw new Error("Invalid ZIP64 directory");
      const zip64 = await read(Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (zip64.readUInt32LE(0) !== 0x06064b50) throw new Error("Invalid ZIP64 directory");
      directorySize = Number(zip64.readBigUInt64LE(40));
      directoryStart = Number(zip64.readBigUInt64LE(48));
    }
    if (!Number.isSafeInteger(directoryStart) || !Number.isSafeInteger(directorySize) ||
        directoryStart < 0 || directorySize < 0 || directoryStart + directorySize > size ||
        directorySize > 8 * 1024 * 1024) throw new Error("Invalid ZIP directory");
    // The index has a strict 8 MiB bound. Read all of it so even a change to
    // a middle entry's CRC alters the incarnation witness.
    for (let at = 0; at < directorySize; at += 64 * 1024)
      digest.update(await read(directoryStart + at, Math.min(64 * 1024, directorySize - at)));
    // Detect nonconforming archives that rewrite the payload but neglect the
    // directory: sample independent locations outside the directory as well.
    for (const ratio of [0, 0.25, 0.5, 0.75])
      digest.update(await read(Math.max(0, Math.floor((size - Math.min(size, 4096)) * ratio)), Math.min(size, 4096)));
    return `v2-${digest.digest("hex").slice(0, 20)}`;
  } finally { await handle.close(); }
}

// Open archives are kept briefly so turning pages doesn't reopen the file.
// Active readers own a short lease; eviction cannot close their file handle.
const open = new Map();
const KEEP_MS = 60_000;
async function withArchive(file, stamp, read) {
  const key = `${file}|${stamp}`;
  let entry = open.get(key);
  if (!entry) {
    entry = { zip: openZip(file), timer: null, refs: 0, retired: false };
    open.set(key, entry);
    if (open.size > 4) close(open.keys().next().value);
  }
  clearTimeout(entry.timer);
  entry.refs++;
  try {
    return await read(await entry.zip);
  } catch (error) {
    // A rejected ZIP open/read is never a valid reusable cache entry.
    close(key);
    throw error;
  } finally {
    entry.refs--;
    if (entry.refs === 0) {
      if (entry.retired) void entry.zip.then((zip) => zip.close()).catch(() => {});
      else {
        entry.timer = setTimeout(() => close(key), KEEP_MS);
        entry.timer.unref?.();
      }
    }
  }
}
function close(key) {
  const entry = open.get(key);
  if (!entry) return;
  open.delete(key);
  clearTimeout(entry.timer);
  entry.retired = true;
  if (entry.refs === 0) void entry.zip.then((zip) => zip.close()).catch(() => {});
}
export function closeAllArchives() { for (const key of [...open.keys()]) close(key); }
export function invalidateArchive(file) {
  for (const key of [...open.keys()]) if (key.startsWith(`${file}|`)) close(key);
}

// { pages: [name], comicInfo } for one file record { path, kind, mtime }.
export async function listPages(file) {
  if (file.kind === "folder") {
    const names = (await fs.readdir(file.path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && IMAGE_EXT.test(entry.name)).map((entry) => entry.name)
      .sort(naturalCompare).slice(0, MAX_FOLDER_IMAGES);
    let comicInfo = null;
    try { comicInfo = parseComicInfo(await fs.readFile(path.join(file.path, "ComicInfo.xml"), "utf8")); } catch {}
    return { pages: names, comicInfo };
  }
  return withArchive(file.path, `${file.mtime}:${file.content_rev || ""}`, async (zip) => {
    const pages = zip.entries.filter((entry) => IMAGE_EXT.test(entry.name) && !/(^|\/)__MACOSX\//.test(entry.name))
      .map((entry) => entry.name).sort(naturalCompare);
    const info = zip.entries.find((entry) => /(^|\/)ComicInfo\.xml$/i.test(entry.name));
    let comicInfo = null;
    if (info && info.size < 200_000) {
      try { comicInfo = parseComicInfo((await zip.read(info)).toString("utf8")); } catch {}
    }
    return { pages, comicInfo };
  });
}

// Bytes and MIME type of page n, or null when it doesn't exist.
export async function readPage(file, pageName) {
  let buffer;
  if (file.kind === "folder") {
    if (pageName.includes("/") || pageName.includes("\\") || pageName.includes("..")) return null;
    const full = path.join(file.path, pageName);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    buffer = await fs.readFile(full);
  } else {
    buffer = await withArchive(file.path, `${file.mtime}:${file.content_rev || ""}`, async (zip) => {
      const entry = zip.entries.find((item) => item.name === pageName);
      return entry ? zip.read(entry) : null;
    });
    if (!buffer) return null;
  }
  const type = sniffImage(buffer);
  return type ? { buffer, type } : null;
}
