import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseEncodedH264Mse } from '../frontend/player/remux-mse.js';

function fixture(t, extras = {}) {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: () => true };
  t.after(() => { globalThis.MediaSource = previous; });
  return {
    video: { requestVideoFrameCallback() {} },
    media: { video: { codec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le',
      bitDepth: 10, colorTransfer: 'bt709', colorPrimaries: 'bt709', colorSpace: 'bt709' },
    compatibility: { video: { hdr: false, bitDepth: 10 } } },
    context: { baseUrl: '/api/torrents/self/files/0/transcode', forceH264: true },
    query: new URLSearchParams('video=h264&start=0.000&audio=0'),
    ...extras,
  };
}

test('HEVC Main10 SDR output to verified H264 supports bounded MSE only under explicit compatible plan', t => {
  const opts = fixture(t);
  assert.equal(canUseEncodedH264Mse(opts), true);
  assert.equal(canUseEncodedH264Mse({ ...opts, query: new URLSearchParams('video=copy') }), false);
  assert.equal(canUseEncodedH264Mse({ ...opts, query: new URLSearchParams('start=30') }), false);
  assert.equal(canUseEncodedH264Mse({ ...opts, context: {} }), false);
  assert.equal(canUseEncodedH264Mse({ ...opts, video: {} }), false);
});

test('HEVC HDR, Dolby Vision, BT2020 and unsupported sources do not activate encoded MSE', t => {
  const opts = fixture(t);
  for (const change of [
    { media: { ...opts.media, compatibility: { video: { hdr: true } } } },
    { media: { ...opts.media, compatibility: { video: { hdrKind: 'hdr10' } } } },
    { media: { ...opts.media, video: { ...opts.media.video, hdrKind: 'hlg' } } },
    { media: { ...opts.media, video: { ...opts.media.video, dolbyVision: true } } },
    { media: { ...opts.media, video: { ...opts.media.video, colorTransfer: 'smpte2084' } } },
    { media: { ...opts.media, video: { ...opts.media.video, colorPrimaries: 'bt2020' } } },
    { media: { ...opts.media, video: { ...opts.media.video, colorSpace: 'bt2020nc' } } },
    { media: { ...opts.media, video: { ...opts.media.video, codec: 'av1' } } },
    { media: { ...opts.media, video: { ...opts.media.video, bitDepth: 8, pixelFormat: 'yuv420p' } } },
  ]) assert.equal(canUseEncodedH264Mse({ ...opts, ...change }), false, JSON.stringify(change));
});

test('MSE requires browser-backed accurate frame API and supported AAC/H264 SourceBuffer', t => {
  const opts = fixture(t);
  globalThis.MediaSource = { isTypeSupported: () => false };
  assert.equal(canUseEncodedH264Mse(opts), false);
  globalThis.MediaSource = undefined;
  assert.equal(canUseEncodedH264Mse(opts), false);
});
