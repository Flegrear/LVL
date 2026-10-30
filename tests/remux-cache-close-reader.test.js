import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const from = source.indexOf('  if (remuxIdentity && typeof remuxSegmentCache !== "undefined") {');
const to = source.indexOf('  // Encoder detection is asynchronous.', from);
assert.ok(from > 0 && to > from, 'test the real cached replay handler');

test('aborting complete cache replay destroys stalled reader and releases its owned FileHandle lease', async () => {
  const res = new PassThrough();
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  const reader = new Readable({ read() {} }); // Synthetic slow disk never produces a chunk.
  let released = 0;
  let opened = 0;
  const cache = {
    openComplete: async () => ({
      bytes: 16,
      handle: { createReadStream(options) {
        assert.equal(options.start, 0);
        assert.equal(options.end, 15);
        assert.equal(options.autoClose, false);
        return reader;
      } },
      async release() { released++; },
    }),
  };
  const ctx = { remuxIdentity: { sessionId: 'private' },
    remuxSegmentCache: cache, req: { aborted: false }, res, pipeline, fileIndex: 0,
    outputHeaders: () => ({ 'Content-Type': 'video/mp4' }),
    session: {}, trackOpenStream: () => { opened++; } };
  await vm.runInNewContext(`(async function () { ${source.slice(from, to)} })()`, ctx);
  assert.equal(opened, 1);
  assert.equal(reader.destroyed, false);
  res.destroy(); // Rapid seek closes HTTP before cache bytes arrive.
  for (let attempt = 0; attempt < 40 && released === 0; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reader.destroyed, true, 'a paused disk stream cannot pin a Windows handle');
  assert.equal(released, 1, 'the lease is released after the pipeline has shut down');
});
