import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalReaderRoles } from '../backend/media/internal-reader-roles.js';
import { createStreamHealth } from '../backend/media/stream-health.js';

const TOKEN1 = 'a'.repeat(48);
const TOKEN2 = 'b'.repeat(48);
const ID = '11111111-1111-4111-8111-111111111111';
const base = `http://127.0.0.1:5000/api/torrents/${ID}/files/2/stream`;
const session = () => ({ id: ID, torrent: {
  numPeers: 1, downloadSpeed: 4096, pieceLength: 1024,
  files: [{}, {}, { offset: 0, length: 8192 }],
  bitfield: { get: () => false },
} });

test('server-issued opaque role is bound to session OBJECT and file, not public role query/headers', () => {
  const owner = session(), replacement = session();
  const roles = createInternalReaderRoles({ port: 5000, createToken: () => TOKEN1 });
  const lease = roles.issue(owner, 2, 'subtitle');
  assert.ok(lease);
  const url = new URL(lease.urlFor(base));
  assert.equal(url.searchParams.get('lvl_reader'), TOKEN1);
  assert.equal(roles.classify(owner, 2, url.searchParams.get('role')), 'unknown');
  assert.equal(roles.classify(owner, 2, 'subtitle'), 'unknown');
  assert.equal(roles.classify(owner, 1, TOKEN1), 'unknown');
  assert.equal(roles.classify(replacement, 2, TOKEN1), 'unknown');
  assert.equal(roles.classify(owner, 2, TOKEN1), 'subtitle');
  const health = createStreamHealth();
  const reader = health.begin(owner, { fileIndex: 2, start: 0, end: 100,
    role: roles.classify(owner, 2, TOKEN1) });
  const diagnostic = health.snapshot(owner, { fileIndex: 2 });
  assert.equal(diagnostic.readers[0].role, 'subtitle');
  assert.equal(diagnostic.playheadVerified, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /aaaa|lvl_reader|11111111/);
  reader.end();
  lease.release();
  lease.release();
  assert.equal(roles.classify(owner, 2, TOKEN1), 'unknown');
});

test('never tags an external URL, forged source session/file, or arbitrary local endpoint', () => {
  const owner = session(), roles = createInternalReaderRoles({ port: 5000, createToken: () => TOKEN1 });
  const lease = roles.issue(owner, 2, 'speech');
  assert.throws(() => lease.urlFor('https://example.com/video'), /local torrent stream/);
  assert.throws(() => lease.urlFor(base.replace('127.0.0.1', 'localhost')), /local torrent stream/);
  assert.throws(() => lease.urlFor(base.replace(':5000/', ':4273/')), /local torrent stream/);
  assert.throws(() => lease.urlFor(base.replace('/files/2/', '/files/1/')), /local torrent stream/);
  assert.throws(() => lease.urlFor(base.replace(ID, '22222222-2222-4222-8222-222222222222')), /local torrent stream/);
  assert.throws(() => lease.urlFor('http://127.0.0.1:5000/api/health'), /local torrent stream/);
  assert.equal(roles.classify(owner, 2, 'x'.repeat(48)), 'unknown');
  assert.equal(roles.classify(owner, 2, TOKEN1), 'speech');
});

test('leases expire, cap HTTP subreads, and fail closed without denying /stream', () => {
  let time = 1000, index = 0;
  const roles = createInternalReaderRoles({
    now: () => time,
    port: 5000,
    createToken: () => [TOKEN1, TOKEN2][index++],
    maxRequestsPerLease: 2, maxLeasesPerSession: 1, ttlMs: 5000,
  });
  const owner = session();
  const first = roles.issue(owner, 2, 'conversion');
  assert.ok(first);
  assert.equal(roles.issue(owner, 2, 'probe'), null, 'capacity stays bounded');
  assert.equal(roles.classify(owner, 2, TOKEN1), 'conversion');
  assert.equal(roles.classify(owner, 2, TOKEN1), 'conversion');
  assert.equal(roles.classify(owner, 2, TOKEN1), 'unknown', 'max subreads retires role');
  const second = roles.issue(owner, 2, 'probe');
  assert.ok(second);
  time += 5001;
  assert.equal(roles.classify(owner, 2, TOKEN2), 'unknown');
  first.release();
  second.release();
  assert.equal(roles.issue(owner, 2, 'browser-direct'), null, 'browser role is not verifiable via child tag');
});

test('invalid or colliding tokens never grant a role; session cleanup invalidates all leases', () => {
  const owner = session();
  const roles = createInternalReaderRoles({ port: 5000, createToken: () => TOKEN1 });
  assert.equal(roles.issue(null, 2, 'probe'), null);
  assert.equal(roles.issue({}, 2, 'probe'), null);
  assert.equal(roles.issue(owner, -1, 'probe'), null);
  assert.equal(roles.issue(owner, 2, 'made-up-role'), null);
  assert.ok(roles.issue(owner, 2, 'probe'));
  assert.equal(roles.issue(owner, 2, 'probe'), null, 'duplicate token rejected');
  roles.clear(owner);
  assert.equal(roles.classify(owner, 2, TOKEN1), 'unknown');
  const unsafe = createInternalReaderRoles({ port: 5000, createToken: () => 'public predictable text' });
  assert.equal(unsafe.issue(owner, 2, 'subtitle'), null);
  assert.equal(createInternalReaderRoles().issue(owner, 2, 'probe'), null,
    'missing explicit own server port cannot issue diagnostics');
});
