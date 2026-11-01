// Mihon and Tachiyomi backups (.tachibk, .proto.gz): a gzip-compressed protobuf "Backup"
// (Mihon app/src/main/java/eu/kanade/tachiyomi/data/backup/models/, read 2026-11-01).
// Only the fields LVL uses are read; other fields, and the extra fields of forks
// (TachiyomiSY, J2K, Komikku), are skipped.
//   Backup         1 manga, 101 sources, 106 extension repositories
//   BackupManga    1 source id, 2 url, 3 title, 5 author, 9 cover URL, 13 date added,
//                  16 chapters, 18 tracking, 100 in the library (default true), 104 history
//   BackupChapter  1 url, 2 name, 4 read, 6 last page read, 8 upload date, 9 number (float)
//   BackupTracking 1 tracker (1 MyAnimeList, 2 AniList), 3 media id (older files),
//                  6 last chapter read, 8 score, 9 status, 100 media id
//   BackupHistory  1 chapter url, 2 last read (ms)
//   BackupSource   1 name, 2 source id
//   Repository     1 address (or its index.min.json), 2 name, 5 signing key
// Fields left out by the writer have their default (kotlinx protobuf skips defaults).
import zlib from "node:zlib";

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const LIMITS = Object.freeze({ manga: 20_000, chapters: 20_000, tracking: 20, history: 20_000, sources: 10_000, stores: 50, text: 4000 });
const decoder = new TextDecoder();

export const backupError = (message = "This isn't a Mihon or Tachiyomi backup", status = 400) => Object.assign(new Error(message), { status, code: "not-backup" });

// A protobuf reader over bytes[start, end).
class Reader {
  constructor(bytes, start = 0, end = bytes.length) { this.bytes = bytes; this.at = start; this.end = end; }
  more() { return this.at < this.end; }
  byte() {
    if (this.at >= this.end) throw backupError();
    return this.bytes[this.at++];
  }
  // Unsigned varint as a Number (exact below 2^53; larger values only appear in fields read with id()).
  uint() {
    let value = 0;
    let scale = 1;
    for (let n = 0; n < 10; n += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw backupError();
  }
  // A 64-bit id (source ids reach 2^63) as its signed decimal text.
  id() {
    let value = 0n;
    let shift = 0n;
    for (let n = 0; n < 10; n += 1) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return BigInt.asIntN(64, value).toString();
      shift += 7n;
    }
    throw backupError();
  }
  key() {
    const key = this.uint();
    const field = Math.floor(key / 8);
    if (!field) throw backupError();
    return [field, key % 8];
  }
  span() {
    const length = this.uint();
    const start = this.at;
    if (start + length > this.end) throw backupError();
    this.at += length;
    return [start, this.at];
  }
  string() {
    const [start, end] = this.span();
    return decoder.decode(this.bytes.subarray(start, Math.min(end, start + LIMITS.text * 4))).slice(0, LIMITS.text);
  }
  float() {
    if (this.at + 4 > this.end) throw backupError();
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getFloat32(0, true);
    this.at += 4;
    return Number.isFinite(value) ? value : 0;
  }
  skip(wire) {
    if (wire === 0) this.uint();
    else if (wire === 1) { if (this.at + 8 > this.end) throw backupError(); this.at += 8; }
    else if (wire === 2) this.span();
    else if (wire === 5) { if (this.at + 4 > this.end) throw backupError(); this.at += 4; }
    else throw backupError(); // groups (3, 4) never appear in these backups
  }
}

// Calls read(field, wire, reader) for each field of the message in bytes[start, end);
// read returns true when it used the field, else the field is skipped.
function eachField(bytes, start, end, read) {
  const reader = new Reader(bytes, start, end);
  while (reader.more()) {
    const [field, wire] = reader.key();
    if (!read(field, wire, reader)) reader.skip(wire);
  }
}
const nested = (reader, bytes, decode) => { const [start, end] = reader.span(); return decode(bytes, start, end); };

function readChapter(bytes, start, end) {
  const chapter = { url: "", name: "", read: false, lastPageRead: 0, dateUpload: 0, number: 0 };
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 2) chapter.url = r.string();
    else if (field === 2 && wire === 2) chapter.name = r.string();
    else if (field === 4 && wire === 0) chapter.read = r.uint() !== 0;
    else if (field === 6 && wire === 0) chapter.lastPageRead = Math.min(r.uint(), 100_000);
    else if (field === 8 && wire === 0) chapter.dateUpload = r.uint();
    else if (field === 9 && wire === 5) chapter.number = r.float();
    else return false;
    return true;
  });
  return chapter;
}

function readTracking(bytes, start, end) {
  const track = { tracker: 0, mediaId: "0", lastChapterRead: 0, score: 0, status: 0 };
  let oldId = "0";
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 0) track.tracker = r.uint();
    else if (field === 3 && wire === 0) oldId = r.id();
    else if (field === 6 && wire === 5) track.lastChapterRead = r.float();
    else if (field === 8 && wire === 5) track.score = r.float();
    else if (field === 9 && wire === 0) track.status = r.uint();
    else if (field === 100 && wire === 0) track.mediaId = r.id();
    else return false;
    return true;
  });
  if (track.mediaId === "0") track.mediaId = oldId;
  return track;
}

function readHistory(bytes, start, end) {
  const item = { url: "", lastRead: 0 };
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 2) item.url = r.string();
    else if (field === 2 && wire === 0) item.lastRead = r.uint();
    else return false;
    return true;
  });
  return item;
}

function readManga(bytes, start, end) {
  const manga = { sourceId: "0", url: "", title: "", author: "", cover: "", dateAdded: 0, favorite: true, chapters: [], tracking: [], history: [] };
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 0) manga.sourceId = r.id();
    else if (field === 2 && wire === 2) manga.url = r.string();
    else if (field === 3 && wire === 2) manga.title = r.string();
    else if (field === 5 && wire === 2) manga.author = r.string();
    else if (field === 9 && wire === 2) manga.cover = r.string();
    else if (field === 13 && wire === 0) manga.dateAdded = r.uint();
    else if (field === 16 && wire === 2) { const item = nested(r, bytes, readChapter); if (manga.chapters.length < LIMITS.chapters) manga.chapters.push(item); }
    else if (field === 18 && wire === 2) { const item = nested(r, bytes, readTracking); if (manga.tracking.length < LIMITS.tracking) manga.tracking.push(item); }
    else if (field === 100 && wire === 0) manga.favorite = r.uint() !== 0;
    else if (field === 104 && wire === 2) { const item = nested(r, bytes, readHistory); if (manga.history.length < LIMITS.history) manga.history.push(item); }
    else return false;
    return true;
  });
  return manga;
}

function readSource(bytes, start, end) {
  const source = { name: "", id: "0" };
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 2) source.name = r.string();
    else if (field === 2 && wire === 0) source.id = r.id();
    else return false;
    return true;
  });
  return source;
}

function readStore(bytes, start, end) {
  const store = { url: "", name: "", signingKey: "" };
  eachField(bytes, start, end, (field, wire, r) => {
    if (field === 1 && wire === 2) store.url = r.string();
    else if (field === 2 && wire === 2) store.name = r.string();
    else if (field === 5 && wire === 2) store.signingKey = r.string();
    else return false;
    return true;
  });
  return store;
}

// The backup file's bytes -> { manga, sources: Map(id -> name), stores }.
export function readBackup(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (!bytes.length) throw backupError("The file is empty");
  if (bytes.length > MAX_BACKUP_BYTES) throw backupError("The backup is larger than 50 MB", 413);
  if (bytes[0] === 0x7b) throw backupError("This is an old Tachiyomi JSON backup. Create a new backup in Mihon or Tachiyomi and import that file");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }); } catch (error) {
      throw error?.code === "ERR_BUFFER_TOO_LARGE" ? backupError("The backup unpacks to more than 256 MB", 413) : backupError();
    }
  }
  const backup = { manga: [], sources: new Map(), stores: [] };
  eachField(bytes, 0, bytes.length, (field, wire, r) => {
    if (field === 1 && wire === 2) { const item = nested(r, bytes, readManga); if (backup.manga.length < LIMITS.manga) backup.manga.push(item); }
    else if (field === 101 && wire === 2) { const item = nested(r, bytes, readSource); if (backup.sources.size < LIMITS.sources && item.id !== "0") backup.sources.set(item.id, item.name); }
    else if (field === 106 && wire === 2) { const item = nested(r, bytes, readStore); if (backup.stores.length < LIMITS.stores && item.url) backup.stores.push(item); }
    else return false;
    return true;
  });
  if (!backup.manga.length) throw backupError("This backup has no comics in it");
  return backup;
}
