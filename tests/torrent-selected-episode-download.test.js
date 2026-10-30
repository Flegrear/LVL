import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const begin = server.indexOf('function selectPreferredTorrentDownload(');
const end = server.indexOf('\nasync function createTorrentSession(', Math.max(0, begin));
assert.ok(begin >= 0 && end > begin,
  'production backend must explicitly select the preferred video download beyond a live HTTP reader');
assert.match(server.slice(end, end + 4000),
  /if \(preferredFileIndex !== null\)[^\n]*\n\s*selectPreferredTorrentDownload\(existingSession\)/,
  'reusing a pack for a different episode updates the persistent selected-file download');
assert.match(server.slice(end, end + 5000),
  /session\.state = "ready";[\s\S]{0,160}selectPreferredTorrentDownload\(session\)/,
  'new torrent metadata selects its preferred episode after manifest safety validation');

function fixture() {
  const calls = [];
  const files = ['one.mkv', 'two.mkv', 'cover.jpg'].map((name, index) => ({
    name, length: index === 2 ? 1024 : 10_000,
    select() { calls.push(`select:${index}`); },
    deselect() { calls.push(`deselect:${index}`); },
  }));
  const session = {
    state: 'ready', safety: { ok: true }, preferredFileIndex: 1,
    torrent: { files }, downloadSelectionIndex: null,
  };
  const ctx = vm.createContext({
    Number, path: { extname: (name) => name.slice(name.lastIndexOf('.')) },
    VIDEO_EXTENSIONS: new Set(['.mkv', '.mp4']),
    MAX_TORRENT_VIDEO_BYTES: 100_000,
    storage: { limits: () => ({ playerBytes: 20_000 }) },
  });
  vm.runInContext(server.slice(begin, end), ctx);
  return { session, files, calls, choose: () => vm.runInContext('selectPreferredTorrentDownload', ctx)(session) };
}

test('download keeps progressing for only the selected episode after all HTTP readers close', () => {
  const f = fixture();
  f.choose();
  assert.deepEqual(f.calls, ['select:1']);
  f.choose();
  assert.deepEqual(f.calls, ['select:1'], 'repeated status refresh must not stack duplicate selections');
  f.session.preferredFileIndex = 0;
  f.choose();
  assert.deepEqual(f.calls, ['select:1', 'deselect:1', 'select:0']);
});

test('reject missing, unsafe, oversized, or non-video preferred downloads', () => {
  const f = fixture();
  f.session.preferredFileIndex = 2;
  f.choose();
  assert.deepEqual(f.calls, [], 'sidecars never start downloading as preferred videos');
  f.session.preferredFileIndex = 8;
  f.choose();
  assert.deepEqual(f.calls, []);
  f.session.preferredFileIndex = 0;
  f.session.safety = { ok: false };
  f.choose();
  assert.deepEqual(f.calls, []);
  f.session.safety = { ok: true };
  f.files[0].length = 50_000;
  f.choose();
  assert.deepEqual(f.calls, [], 'respect player cache allocation limit');
});
