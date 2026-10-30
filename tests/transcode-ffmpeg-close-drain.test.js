import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { once } from 'node:events';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf('async function transcodeTorrentFile(');
const end = server.indexOf('\nfunction boundedInteger(', start);
assert.ok(start >= 0 && end > start, 'production torrent transcode route is present');
const productionRoute = server.slice(start, end);

test('production FFmpeg close does not end HTTP response before its pipe has drained', () => {
  // ChildProcess.close is not equivalent to the Transform or HTTP Writable
  // finishing: the recorder and socket may still hold the trailing MP4 atoms.
  const closeStart = productionRoute.indexOf('ffmpeg.once("close", (code) => {');
  assert.ok(closeStart >= 0);
  const handler = productionRoute.slice(closeStart);
  assert.doesNotMatch(handler, /if\s*\(!res\.writableEnded\)\s*res\.end\(\)/,
    'Never truncate a still-draining FFmpeg -> optional recorder -> socket pipe');
});

async function transcodePipe({ prematurelyEnd }) {
  const blocks = Array.from({ length: 10 }, (_, i) => Buffer.alloc(65536, i + 1));
  const original = Buffer.concat(blocks);
  let transmitted = 0;
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      setTimeout(() => { transmitted += chunk.length; callback(); }, 8);
    },
  });
  const optionalRecorder = new Transform({
    transform(chunk, _encoding, callback) {
      // Async transform simulates producer data draining later than its close.
      setTimeout(() => callback(null, chunk), 3);
    },
  });
  const ffmpegStdout = Readable.from(blocks);
  ffmpegStdout.pipe(optionalRecorder).pipe(response);
  if (prematurelyEnd) ffmpegStdout.once('end', () => response.end());
  await once(response, 'finish');
  return { expected: original.length, transmitted };
}

test('a slow HTTP consumer loses MP4 tail if ended on FFmpeg close, but intact pipe drains fully', async () => {
  const bad = await transcodePipe({ prematurelyEnd: true });
  assert.ok(bad.transmitted < bad.expected, 'old FFmpeg-close shortcut truncates queued output');
  const good = await transcodePipe({ prematurelyEnd: false });
  assert.equal(good.transmitted, good.expected, 'letting the existing pipe end completes all output');
});
