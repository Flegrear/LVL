// A remux producer may run ahead of the browser only when doing so cannot
// initiate competing torrent piece downloads. This is a conservative check
// of the exact selected file's WebTorrent-verified piece bitfield, not a guess
// based on reported progress percentage, arbitrary byte ranges or peers.
const MAX_PIECES_PER_FILE = 200_000;

export function isTorrentFileFullyVerified(torrent, fileIndex) {
  const file = Number.isSafeInteger(fileIndex) && fileIndex >= 0
    ? torrent?.files?.[fileIndex] : null;
  const bytes = Number(file?.length);
  const offset = Number(file?.offset);
  const pieceBytes = Number(torrent?.pieceLength);
  if (!file || file.done !== true || !Number.isSafeInteger(bytes) ||
    bytes <= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(pieceBytes) || pieceBytes <= 0 ||
    Number(file.downloaded) !== bytes ||
    typeof torrent?.bitfield?.get !== "function") return false;
  const lastByte = offset + bytes - 1;
  if (!Number.isSafeInteger(lastByte)) return false;
  const first = Math.floor(offset / pieceBytes);
  const last = Math.floor(lastByte / pieceBytes);
  if (last < first || last - first + 1 > MAX_PIECES_PER_FILE) return false;
  try {
    for (let i = first; i <= last; i++) {
      const verified = torrent.bitfield.get(i);
      if (verified !== true && verified !== 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}
