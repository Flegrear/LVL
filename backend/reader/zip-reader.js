// Minimal, bounded ZIP reader for comic archives (.cbz/.zip). Reads the central
// directory at the end of the file, then single entries on demand, so a large
// volume is never loaded whole. Stored (0) and deflate (8) entries only; any
// encrypted, oversized or malformed archive is rejected with a clear error.
import fs from "node:fs/promises";
import zlib from "node:zlib";

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxRatio: 200,
  maxCentralDirectoryBytes: 8 * 1024 * 1024,
});

const fail = (message) => { throw Object.assign(new Error(message), { code: "BAD_ARCHIVE" }); };

// Deflate can grow slightly on incompressible input. Allow bounded overhead,
// not an attacker-controlled compressed buffer far larger than the entry cap.
// With default limits, a single compressed entry is limited to 41 MiB.
const compressedBudget = (limits) => limits.maxEntryBytes + Math.min(1024 * 1024, Math.ceil(limits.maxEntryBytes / 16));
const safeRange = (value) => Number.isSafeInteger(value) && value >= 0;

function checkedEntry(entry, limits, fileSize) {
  const { size, csize, offset, method } = entry;
  if (![size, csize, offset].every(safeRange)) fail("Invalid entry size or offset");
  if (![0, 8].includes(method)) fail(`Unsupported compression method ${method}`);
  if (size > limits.maxEntryBytes) fail("Entry is too large");
  if (method === 0 && csize !== size) fail("Stored entry compressed size doesn't match its size");
  if (method === 8 && csize > compressedBudget(limits)) fail("Compressed entry is too large");
  if (csize > 0 && size / csize > limits.maxRatio) fail("Compression ratio is suspicious");
  if (offset > fileSize - 30 || csize > fileSize - offset) fail("Entry points outside the archive");
  return { size, csize, offset, method };
}

async function readAt(handle, position, length) {
  if (!safeRange(position) || !safeRange(length)) fail("Invalid archive offset or read size");
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail("Archive is truncated");
  return buffer;
}

function zip64Extra(extra, needs) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    if (at + 4 + size > extra.length) fail("Bad ZIP64 field");
    if (id === 0x0001) {
      let cursor = at + 4;
      const take = () => { if (cursor + 8 > at + 4 + size || cursor + 8 > extra.length) fail("Bad ZIP64 field"); const raw = extra.readBigUInt64LE(cursor); cursor += 8; if (raw > BigInt(Number.MAX_SAFE_INTEGER)) fail("Invalid ZIP64 integer"); return Number(raw); };
      return { size: needs.size ? take() : null, csize: needs.csize ? take() : null, offset: needs.offset ? take() : null };
    }
    at += 4 + size;
  }
  return fail("Missing ZIP64 field");
}

export function safeEntryName(name) {
  const text = String(name || "");
  if (!text || text.length > 400 || text.includes("\0") || text.startsWith("/") || text.startsWith("\\") || /^[a-z]:/i.test(text)) return false;
  return !text.split(/[\\/]/).some((part) => part === "..");
}

export async function openZip(file, limits = ZIP_LIMITS) {
  const handle = await fs.open(file, "r");
  try {
    const { size: fileSize } = await handle.stat();
    if (!safeRange(fileSize)) fail("Invalid archive size");
    if (fileSize < 22) fail("Not a ZIP archive");
    const tailLength = Math.min(fileSize, 65_557);
    const tail = await readAt(handle, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
    if (eocd < 0) fail("Not a ZIP archive");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorAt = eocd - 20;
      if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== 0x07064b50) fail("Bad ZIP64 archive");
      const record = await readAt(handle, Number(tail.readBigUInt64LE(locatorAt + 8)), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) fail("Bad ZIP64 archive");
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (!safeRange(count) || !safeRange(cdSize) || !safeRange(cdOffset)
      || count > limits.maxEntries || cdSize > limits.maxCentralDirectoryBytes || cdOffset > fileSize - cdSize)
      fail("Bad central directory");
    const cd = await readAt(handle, cdOffset, cdSize);
    const entries = [];
    let total = 0;
    for (let at = 0, index = 0; index < count; index += 1) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== 0x02014b50) fail("Bad central directory entry");
      const flags = cd.readUInt16LE(at + 8);
      const method = cd.readUInt16LE(at + 10);
      let csize = cd.readUInt32LE(at + 20);
      let size = cd.readUInt32LE(at + 24);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      let offset = cd.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > cd.length) fail("Bad central directory entry");
      const rawName = cd.subarray(at + 46, at + 46 + nameLength);
      const name = (flags & 0x0800 ? rawName.toString("utf8") : rawName.toString("latin1")).replace(/\\/g, "/");
      if (size === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
        const extra = zip64Extra(cd.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
          { size: size === 0xffffffff, csize: csize === 0xffffffff, offset: offset === 0xffffffff });
        size = extra.size ?? size; csize = extra.csize ?? csize; offset = extra.offset ?? offset;
      }
      at += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith("/")) continue;
      if (!safeEntryName(name)) fail(`Unsafe entry name: ${name.slice(0, 80)}`);
      if (flags & 0x0001) fail("Encrypted archives aren't supported");
      checkedEntry({ size, csize, offset, method }, limits, fileSize);
      total += size;
      if (total > limits.maxTotalBytes) fail("Archive expands beyond the size limit");
      entries.push({ name, method, size, csize, offset });
    }
    return {
      entries,
      async read(entry) {
        // Snapshot and validate again: callers can retain/mutate entry objects
        // after indexing, but cannot make payload reads allocate past the cap.
        const checked = checkedEntry(entry, limits, fileSize);
        const local = await readAt(handle, checked.offset, 30);
        if (local.readUInt32LE(0) !== 0x04034b50) fail("Bad local header");
        if (local.readUInt16LE(8) !== checked.method) fail("Entry method doesn't match local header");
        const start = checked.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (!safeRange(start) || checked.csize > fileSize - start) fail("Entry points outside the archive");
        const raw = await readAt(handle, start, checked.csize);
        if (checked.method === 0) return raw;
        const data = zlib.inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
        if (data.length !== checked.size) fail("Entry size doesn't match");
        return data;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
