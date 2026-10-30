import test from "node:test";
import assert from "node:assert/strict";
import { isTorrentFileFullyVerified } from "../backend/media/verified-torrent-file.js";

const all = () => ({ files: [{ offset: 1000, length: 1200, downloaded: 1200, done: true }],
  pieceLength: 512, bitfield: { get: i => [1, 2, 3, 4].includes(i) } });

test("requires every verified piece spanning the actual selected torrent file", () => {
  assert.equal(isTorrentFileFullyVerified(all(), 0), true);
  const incomplete = all();
  incomplete.bitfield.get = index => index !== 3 && index >= 1 && index <= 4;
  assert.equal(isTorrentFileFullyVerified(incomplete, 0), false);
  const invalid = all();
  invalid.files[0].downloaded = 1199;
  assert.equal(isTorrentFileFullyVerified(invalid, 0), false);
  invalid.files[0].downloaded = 1200;
  invalid.files[0].done = false;
  assert.equal(isTorrentFileFullyVerified(invalid, 0), false);
});

test("fails closed on missing or malformed evidence, even with apparent 100% progress", () => {
  const examples = [null, {}, { files: [] }, { ...all(), bitfield: null },
    { ...all(), pieceLength: 0 }, { ...all(), pieceLength: Infinity },
    { ...all(), files: [{ done: true, downloaded: 100, length: 100, offset: -1 }] },
    { ...all(), files: [{ done: true, downloaded: 200_000_000, length: 200_000_000,
      offset: 0 }], pieceLength: 1 }];
  for (const sample of examples) assert.equal(isTorrentFileFullyVerified(sample, 0), false);
  assert.equal(isTorrentFileFullyVerified(all(), 1), false);
  const broken = all();
  broken.bitfield.get = () => { throw Error("bitfield unavailable"); };
  assert.equal(isTorrentFileFullyVerified(broken, 0), false);
});
