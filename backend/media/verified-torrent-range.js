// Verify an INCLUSIVE, file-relative byte range from WebTorrent's already
// SHA1-verified piece bitfield. Never open/create/select a torrent reader here:
// a WebTorrent reader can request currently missing pieces from peers.
//
// A verified partial range is only eligible for a genuinely local-only read
// path that refuses to fetch missing bytes. Ordinary WebTorrent stream readers
// are admitted only for a fully verified file. Recheck immediately before use:
// the torrent can be destroyed or its bitfield can change after this call.
//
// Piece truth is NOT proof of decoded video, keyframes, packet timestamps,
// byte-to-time correspondence, or a browser-seekable output. Those require
// independent demux/decode and an indexed, finalized playable output segment.

const MAX_PIECES_TO_CHECK = 200_000;
const safeNonnegativeInt = (value) => Number.isSafeInteger(value) && value >= 0;

function failure(reason, details = {}) {
  return {
    verified: false,
    canReadWithoutDownloading: false,
    networkReaderAllowed: false,
    fileComplete: false,
    mediaTimingProven: false,
    reason,
    firstPiece: null,
    lastPiece: null,
    firstMissingPiece: null,
    absoluteStart: null,
    absoluteEnd: null,
    ...details,
  };
}

function allPiecesPresent(bitfield, first, last) {
  for (let piece = first; piece <= last; piece++) {
    let result;
    try { result = bitfield.get(piece); }
    catch { return { ok: false, missing: null, uncertain: true }; }
    if (result === false || result === 0)
      return { ok: false, missing: piece, uncertain: false };
    if (result !== true && result !== 1)
      return { ok: false, missing: null, uncertain: true };
  }
  return { ok: true, missing: null, uncertain: false };
}

/**
 * Synchronous evidence snapshot; no network/disk reads are started.
 *
 * @param {object} torrent - Live WebTorrent object with files, pieceLength and bitfield.get.
 * @param {number} fileIndex - Exact index into torrent.files.
 * @param {{start: number, end: number}} range - File-relative, inclusive byte offsets.
 * @returns {{verified:boolean,canReadWithoutDownloading:boolean,networkReaderAllowed:boolean,
 *   fileComplete:boolean,mediaTimingProven:false,reason:string,firstPiece:number|null,
 *   lastPiece:number|null,firstMissingPiece:number|null,absoluteStart:number|null,absoluteEnd:number|null}}
 *
 * `verified` means every overlapping source piece was hash-verified at check
 * time, NOT that the video at that range has completed decoding/indexing.
 * `networkReaderAllowed` requires the *entire* file to be verified, so callers
 * cannot accidentally trigger peer demand via file.createReadStream() while
 * implementing partial/rolling seek caches.
 */
function inspectTorrentFileByteRange(torrent, fileIndex, range) {
  if (torrent?.destroyed === true) return failure('unknown-source');
  const files = torrent?.files;
  if (!safeNonnegativeInt(fileIndex) || !Array.isArray(files))
    return failure('unknown-source');
  const file = files[fileIndex];
  const bitfield = torrent.bitfield;
  const offset = file?.offset;
  const length = file?.length;
  const pieceLength = torrent.pieceLength;
  if (!file || !safeNonnegativeInt(offset) || !Number.isSafeInteger(length) || length <= 0
    || !Number.isSafeInteger(pieceLength) || pieceLength <= 0
    || typeof bitfield?.get !== 'function') return failure('unknown-source');

  const endOfFile = offset + length - 1;
  if (!Number.isSafeInteger(endOfFile)) return failure('unknown-source');
  const totalBytes = torrent.length;
  if (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes)
    || totalBytes <= endOfFile)) return failure('unknown-source');

  const pieces = torrent.pieces;
  const pieceCount = pieces?.length;
  if (pieces !== undefined && (!Array.isArray(pieces)
    || !safeNonnegativeInt(pieceCount))) return failure('unknown-source');
  if (pieceCount !== undefined) {
    const expected = totalBytes !== undefined ? Math.ceil(totalBytes / pieceLength) : null;
    if ((expected !== null && expected !== pieceCount)
      || Math.floor(endOfFile / pieceLength) >= pieceCount) return failure('unknown-source');
  }

  const start = range?.start, end = range?.end;
  if (!safeNonnegativeInt(start) || !safeNonnegativeInt(end) || start > end || end >= length)
    return failure('invalid-range');
  const absoluteStart = offset + start;
  const absoluteEnd = offset + end;
  if (!Number.isSafeInteger(absoluteStart) || !Number.isSafeInteger(absoluteEnd))
    return failure('invalid-range');
  const firstPiece = Math.floor(absoluteStart / pieceLength);
  const lastPiece = Math.floor(absoluteEnd / pieceLength);
  const fileFirstPiece = Math.floor(offset / pieceLength);
  const fileLastPiece = Math.floor(endOfFile / pieceLength);
  const rangePieceCount = lastPiece - firstPiece + 1;
  if (!rangePieceCount || rangePieceCount > MAX_PIECES_TO_CHECK)
    return failure('range-too-large');

  // Check file-completion flags only as supplementary evidence. Downloaded
  // byte counts and done are not enough without every shared boundary piece.
  const done = file.done;
  const downloaded = file.downloaded;
  let fileComplete = false;
  if (done === true && downloaded === length
    && fileLastPiece - fileFirstPiece + 1 <= MAX_PIECES_TO_CHECK) {
    fileComplete = allPiecesPresent(bitfield, fileFirstPiece, fileLastPiece).ok;
  }

  const present = allPiecesPresent(bitfield, firstPiece, lastPiece);
  // A reattached or restarted torrent can reuse a file index while the
  // original bitfield is still being inspected. Never trust such a snapshot.
  if (torrent.destroyed === true || torrent.files !== files
    || torrent.files[fileIndex] !== file || torrent.bitfield !== bitfield
    || torrent.pieceLength !== pieceLength || file.offset !== offset
    || file.length !== length || file.done !== done || file.downloaded !== downloaded
    || torrent.length !== totalBytes || torrent.pieces !== pieces)
    return failure('source-changed');

  const details = { firstPiece, lastPiece, firstMissingPiece: present.missing,
    absoluteStart, absoluteEnd };
  if (!present.ok) return failure(present.uncertain ? 'unknown-piece-verification' : 'missing-piece', details);
  return {
    ...failure('verified-pieces', details),
    verified: true,
    canReadWithoutDownloading: true,
    // A normal WebTorrent reader can select/seek into missing ranges after
    // startup. Require whole-file completion for that reader class.
    networkReaderAllowed: fileComplete,
    fileComplete,
  };
}

export function verifyTorrentFileByteRange(torrent, fileIndex, range) {
  try { return inspectTorrentFileByteRange(torrent, fileIndex, range); }
  catch { return failure('unknown-source'); }
}

export function isTorrentFileByteRangeVerified(torrent, fileIndex, start, end) {
  return verifyTorrentFileByteRange(torrent, fileIndex, { start, end }).verified;
}
