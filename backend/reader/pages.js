// Pages of a local comic: a .cbz/.zip archive or a folder of images.
import fs from "node:fs/promises";
import path from "node:path";
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

// Open archives are kept briefly so turning pages doesn't reopen the file.
const open = new Map();
const KEEP_MS = 60_000;
async function archive(file, stamp) {
  const key = `${file}|${stamp}`;
  const hit = open.get(key);
  if (hit) {
    clearTimeout(hit.timer);
    hit.timer = setTimeout(() => close(key), KEEP_MS);
    hit.timer.unref?.();
    return hit.zip;
  }
  const zip = openZip(file);
  const entry = { zip, timer: setTimeout(() => close(key), KEEP_MS) };
  entry.timer.unref?.();
  open.set(key, entry);
  if (open.size > 4) close(open.keys().next().value);
  try {
    return await zip;
  } catch (error) {
    open.delete(key);
    throw error;
  }
}
function close(key) {
  const entry = open.get(key);
  if (!entry) return;
  open.delete(key);
  clearTimeout(entry.timer);
  entry.zip.then((zip) => zip.close()).catch(() => {});
}
export function closeAllArchives() { for (const key of [...open.keys()]) close(key); }

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
  const zip = await archive(file.path, file.mtime);
  const pages = zip.entries.filter((entry) => IMAGE_EXT.test(entry.name) && !/(^|\/)__MACOSX\//.test(entry.name))
    .map((entry) => entry.name).sort(naturalCompare);
  const info = zip.entries.find((entry) => /(^|\/)ComicInfo\.xml$/i.test(entry.name));
  let comicInfo = null;
  if (info && info.size < 200_000) {
    try { comicInfo = parseComicInfo((await zip.read(info)).toString("utf8")); } catch {}
  }
  return { pages, comicInfo };
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
    const zip = await archive(file.path, file.mtime);
    const entry = zip.entries.find((item) => item.name === pageName);
    if (!entry) return null;
    buffer = await zip.read(entry);
  }
  const type = sniffImage(buffer);
  return type ? { buffer, type } : null;
}
