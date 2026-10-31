import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyTorrentFileByteRange, isTorrentFileByteRangeVerified,
} from '../backend/media/verified-torrent-range.js';

// Two files can share a boundary piece. File-relative offsets must always
// become torrent-absolute offsets before indexing the verified bitfield.
function fixture({ verified = [1, 2, 3, 4], done = false, downloaded = 1200 } = {}) {
  const seen = [];
  const bits = new Set(verified);
  let readerCalls = 0;
  const file = { offset: 1000, length: 1200, done, downloaded,
    createReadStream() { readerCalls++; throw Error('Network reader must not open in a verifier'); } };
  const torrent = { files: [file], pieceLength: 512, length: 2500,
    pieces: Array(5).fill(null),
    bitfield: { get(index) { seen.push(index); return bits.has(index); } } };
  return { torrent, file, bits, seen, get readerCalls() { return readerCalls; } };
}

test('piece indices include both sides of a boundary in a file beginning mid-piece', () => {
  const f = fixture({ verified: [1] });
  const left = verifyTorrentFileByteRange(f.torrent, 0, { start: 23, end: 23 });
  assert.equal(left.verified, true);
  assert.equal(left.firstPiece, 1);
  assert.equal(left.lastPiece, 1);
  assert.equal(left.absoluteStart, 1023);
  assert.equal(left.absoluteEnd, 1023);
  assert.equal(left.fileComplete, false);
  const crossing = verifyTorrentFileByteRange(f.torrent, 0, { start: 23, end: 24 });
  assert.equal(crossing.verified, false, 'piece 2 is missing for a two-byte crossing');
  assert.equal(crossing.firstPiece, 1);
  assert.equal(crossing.lastPiece, 2);
  assert.equal(crossing.reason, 'missing-piece');
  assert.equal(crossing.firstMissingPiece, 2);
  f.bits.add(2);
  assert.equal(isTorrentFileByteRangeVerified(f.torrent, 0, 23, 24), true);
  assert.equal(f.readerCalls, 0);
});

test('one-byte end of file needs the final boundary piece, never a following piece', () => {
  const f = fixture({ verified: [4] });
  const last = verifyTorrentFileByteRange(f.torrent, 0, { start: 1199, end: 1199 });
  assert.equal(last.verified, true);
  assert.equal(last.firstPiece, 4);
  assert.equal(last.lastPiece, 4);
  assert.equal(last.absoluteEnd, 2199);
  assert.ok(f.seen.every((piece) => piece === 4));
  assert.equal(isTorrentFileByteRangeVerified(f.torrent, 0, 1198, 1200), false);
  assert.equal(f.readerCalls, 0);
});

test('incomplete file permits only already hash-verified partial ranges', () => {
  const f = fixture({ verified: [1, 2], downloaded: 1200, done: false });
  const ready = verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 30 });
  assert.equal(ready.verified, true);
  assert.equal(ready.fileComplete, false);
  assert.equal(ready.mediaTimingProven, false);
  assert.equal(ready.canReadWithoutDownloading, true);
  assert.equal(ready.networkReaderAllowed, false,
    'partial downloaded files may only use a verified local-only read path');
  const later = verifyTorrentFileByteRange(f.torrent, 0, { start: 560, end: 600 });
  assert.equal(later.verified, false);
  assert.equal(later.canReadWithoutDownloading, false);
  assert.equal(later.mediaTimingProven, false);
  assert.equal(later.firstMissingPiece, 3);
  assert.equal(f.readerCalls, 0, 'even rejected checks must not request a torrent reader');
});

test('file completion needs done, exact downloaded count and every boundary piece', () => {
  const f = fixture({ verified: [1, 2, 3, 4], done: true, downloaded: 1200 });
  assert.equal(verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 20 }).fileComplete, true);
  assert.equal(verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 20 }).networkReaderAllowed, true,
    'ordinary torrent reader admission requires verified entire file');
  f.file.done = false;
  assert.equal(verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 20 }).fileComplete, false);
  f.file.done = true;
  f.file.downloaded = 1199;
  assert.equal(verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 20 }).fileComplete, false);
  f.file.downloaded = 1200;
  f.bits.delete(3);
  const incomplete = verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 20 });
  assert.equal(incomplete.verified, true, 'local range is still safe despite another missing piece');
  assert.equal(incomplete.fileComplete, false, '100% downloaded/done cannot supersede bitfield');
  assert.equal(incomplete.networkReaderAllowed, false);
});

test('untrusted shape, invalid byte bounds and numeric coercions fail closed', () => {
  const f = fixture();
  const invalidRanges = [
    { start: -1, end: 1 }, { start: 1.5, end: 2 }, { start: '1', end: 3 },
    { start: 1, end: 0 }, { start: 0, end: 1200 }, { start: NaN, end: 4 },
    { start: 0, end: Infinity }, { start: 0 }, null,
  ];
  for (const range of invalidRanges) {
    const actual = verifyTorrentFileByteRange(f.torrent, 0, range);
    assert.equal(actual.verified, false, JSON.stringify(range));
    assert.equal(actual.canReadWithoutDownloading, false);
  }
  const invalidSources = [null, {}, { ...f.torrent, files: [] },
    { ...f.torrent, bitfield: null }, { ...f.torrent, pieceLength: 0 },
    { ...f.torrent, destroyed: true },
    { ...f.torrent, pieceLength: 1.5 },
    { ...f.torrent, files: [{ ...f.file, offset: -1 }] },
    { ...f.torrent, files: [{ ...f.file, offset: Number.MAX_SAFE_INTEGER }] },
    { ...f.torrent, files: [{ ...f.file, length: 0 }] },
    { ...f.torrent, length: 2000 },
  ];
  for (const candidate of invalidSources)
    assert.equal(verifyTorrentFileByteRange(candidate, 0, { start: 0, end: 0 }).verified, false);
  assert.equal(verifyTorrentFileByteRange(f.torrent, -1, { start: 0, end: 0 }).verified, false);
  assert.equal(verifyTorrentFileByteRange(f.torrent, 1, { start: 0, end: 0 }).verified, false);
  assert.equal(f.readerCalls, 0);
});

test('bitfield exceptions and unknown truthy values never admit an unsafe range', () => {
  const f = fixture();
  for (const value of [undefined, null, '1', 2, -1, {}, NaN]) {
    f.torrent.bitfield.get = () => value;
    const result = verifyTorrentFileByteRange(f.torrent, 0, { start: 23, end: 24 });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'unknown-piece-verification');
    assert.equal(result.firstMissingPiece, null, 'uncertainty is not proof a piece is missing');
  }
  f.torrent.bitfield.get = () => { throw Error('bitfield lost'); };
  const unavailable = verifyTorrentFileByteRange(f.torrent, 0, { start: 23, end: 24 });
  assert.equal(unavailable.verified, false);
  assert.equal(unavailable.reason, 'unknown-piece-verification');
  assert.equal(f.readerCalls, 0);
});

test('metadata replaced mid-check and piece indices beyond known piece count fail closed', () => {
  const f = fixture();
  let replaced = false;
  f.torrent.bitfield.get = () => {
    if (!replaced) { f.torrent.files[0] = { ...f.file }; replaced = true; }
    return true;
  };
  assert.equal(isTorrentFileByteRangeVerified(f.torrent, 0, 0, 40), false);
  const bad = fixture();
  bad.torrent.pieces = [null, null, null, null];
  assert.equal(isTorrentFileByteRangeVerified(bad.torrent, 0, 1199, 1199), false);
  const destroyed = fixture();
  destroyed.torrent.bitfield.get = () => {
    destroyed.torrent.destroyed = true;
    return true;
  };
  assert.equal(isTorrentFileByteRangeVerified(destroyed.torrent, 0, 0, 30), false);
  const swappedPieces = fixture();
  swappedPieces.torrent.bitfield.get = () => {
    swappedPieces.torrent.pieces = Array(5).fill(null);
    return true;
  };
  assert.equal(isTorrentFileByteRangeVerified(swappedPieces.torrent, 0, 0, 30), false);
});

test('throwing metadata getters fail closed without leaking a reader or exception', () => {
  const f = fixture();
  Object.defineProperty(f.torrent, 'files', { get() { throw Error('source removed'); } });
  assert.equal(verifyTorrentFileByteRange(f.torrent, 0, { start: 0, end: 0 }).verified, false);
  assert.equal(f.readerCalls, 0);
});

test('pathological piece counts cannot cause unbounded bitfield scans', () => {
  const calls = [];
  const torrent = { files: [{ offset: 0, length: 500_000, downloaded: 500_000, done: true }],
    pieceLength: 1, bitfield: { get(i) { calls.push(i); return true; } } };
  const result = verifyTorrentFileByteRange(torrent, 0, { start: 0, end: 499999 });
  assert.equal(result.verified, false);
  assert.equal(result.canReadWithoutDownloading, false);
  assert.equal(calls.length, 0);
});
