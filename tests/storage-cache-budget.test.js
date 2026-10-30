import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorageManager } from '../backend/persistence/storage.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test('progressive remux reserves future original torrent bytes within the one player budget', async t => {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-cache-budget-'));
  t.after(() => fs.rm(sharedRoot, { recursive: true, force: true }));
  const sessionsRoot = path.join(sharedRoot, 'port-test');
  const sessionFolder = path.join(sessionsRoot, 'a-session');
  await fs.mkdir(path.join(sessionFolder, '.lvl-remux-cache'), { recursive: true });
  await fs.writeFile(path.join(sessionFolder, 'original-pieces.bin'), Buffer.alloc(2 * MiB));
  await fs.writeFile(path.join(sessionFolder, '.lvl-remux-cache', 'record.mp4'), Buffer.alloc(MiB));

  const metadata = new Map();
  const storage = createStorageManager({
    appDatabase: { getMeta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) },
    sessionsRoot,
    sharedRoot,
    sessions: () => [{ id: 'a-session', busy: true, lastUsedAt: Date.now() }],
    removeSession: async () => assert.fail('the active source must not be evicted'),
    clipStore: { stats: () => ({}), collectGarbage: () => ({}) },
    ankiStore: { listDecks: () => [] },
  });
  storage.setLimits({ playerBytes: 2 * GiB });

  const usage = await storage.playerUsage();
  assert.equal(usage.usedBytes, 3 * MiB, 'torrent pieces and retained remux both count as player storage');
  const reservation = 2 * GiB - 7 * MiB;
  const gate = await storage.playerCacheAllowance({ additionalBytes: 4 * MiB, reservedSourceBytes: reservation });
  assert.equal(gate.limitBytes, 2 * GiB);
  assert.equal(gate.usedBytes, 3 * MiB);
  assert.ok(gate.availableBytes <= 4 * MiB, 'the future original bytes cannot be assigned to remux output');
  assert.equal(gate.allowed, gate.availableBytes >= 4 * MiB);
  assert.equal((await storage.playerCacheAllowance({ additionalBytes: 5 * MiB, reservedSourceBytes: reservation })).allowed, false);
  assert.equal((await storage.playerCacheAllowance({ additionalBytes: MiB, reservedSourceBytes: 2 * GiB })).availableBytes, 0);
  assert.equal((await storage.playerCacheAllowance({ additionalBytes: MiB, reservedSourceBytes: -1 })).allowed, false);
  assert.equal((await storage.playerCacheAllowance({ additionalBytes: MiB, reservedSourceBytes: Infinity })).allowed, false);
  storage.setLimits({ remuxCacheEnabled: false });
  assert.deepEqual((await storage.playerCacheAllowance({ additionalBytes: MiB })).allowed, false);
  assert.equal((await storage.playerUsage()).usedBytes, 3 * MiB, 'disabling remux caching does not delete torrent pieces');
});
