import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import { aacBitRate, planCompatibleAudio } from '../shared/media/audio-policy.js';

test('AUDIO-02/03: invalid or absent channel metadata cannot copy audio or produce invalid FFmpeg -ac', () => {
  for (const bad of [undefined, null, '', 'unknown', '5.1', 0, -1, 1.5, 2.5, Infinity, -Infinity, NaN]) {
    const planned = planCompatibleAudio({ codec: 'aac', channels: bad }, { audioMode: 'surround' });
    assert.equal(planned.codec, 'aac', `unverified channel count ${String(bad)} cannot authorize AAC copy`);
    assert.equal(planned.outputCodec, 'aac');
    assert.ok(Number.isSafeInteger(planned.channels) && planned.channels >= 1 && planned.channels <= 6,
      `invalid FFmpeg -ac from channel metadata ${String(bad)}: ${planned.channels}`);
    assert.equal(planned.channels, 2, `unknown channel count defaults to safe stereo for ${String(bad)}`);
    assert.equal(planned.bitRate, '160k');
  }
  const absentTrack = planCompatibleAudio(null, { audioMode: 'surround' });
  assert.equal(absentTrack.present, false);
  assert.equal(absentTrack.channels, 2);
});

test('AUDIO-01/02/03: verified integer metadata preserves compatible tracks and bounds nonzero-seek or surround fallback', () => {
  for (const codec of ['aac', 'mp3']) {
    for (const value of [1, 2, '2', 6]) {
      const plan = planCompatibleAudio({ codec, channels: value });
      assert.equal(plan.codec, 'copy', `${codec}/${value} at t=0 can keep original encoded audio`);
      assert.equal(plan.outputCodec, codec);
      assert.equal(plan.channels, Number(value));
      assert.equal(plan.bitRate, null);
      const seek = planCompatibleAudio({ codec, channels: value }, { startSeconds: 17.37 });
      assert.equal(seek.codec, 'aac', `${codec}/${value} at seek must re-encode for sync`);
      assert.equal(seek.reason, 'seek-timestamp-safety');
    }
  }
  const surround = planCompatibleAudio({ codec: 'truehd', channels: 8, channelLayout: '7.1' });
  assert.equal(surround.channels, 6);
  assert.equal(surround.bitRate, '384k');
  assert.equal(surround.reason, 'channel-downmix');
  assert.equal(planCompatibleAudio({ codec: 'truehd', channels: 6 }, { audioMode: 'stereo' }).channels, 2);
  assert.equal(aacBitRate(2), '160k');
  assert.equal(aacBitRate(5), '256k');
  assert.equal(aacBitRate(6), '384k');
});

test('AUDIO-03: synthetic AC3 5.1 center-channel dialogue survives AAC stereo downmix in both outputs',
  { timeout: 20_000 }, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-audio-center-'));
    const source = path.join(folder, 'center-only.ac3');
    const output = path.join(folder, 'dialogue-stereo.m4a');
    const exec = (binary, args, { raw = false } = {}) => {
      const result = spawnSync(binary, args, { windowsHide: true, timeout: 10_000,
        encoding: raw ? null : 'utf8', maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, result.error?.message || String(result.stderr));
      return result.stdout;
    };
    try {
      // Native 5.1 order FL,FR,FC,LFE,BL,BR: only FC contains dialogue.
      exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'aevalsrc=0|0|0.25*sin(2*PI*880*t)|0|0|0:s=48000:c=5.1',
        '-t', '0.4', '-c:a', 'ac3', '-b:a', '384k', source]);
      const plan = planCompatibleAudio({ codec: 'ac3', channels: 6, channelLayout: '5.1' },
        { audioMode: 'stereo' });
      assert.equal(plan.channels, 2);
      exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source,
        '-c:a', plan.codec, '-b:a', plan.bitRate, '-ac', String(plan.channels), output]);
      const stream = JSON.parse(exec(ffprobePath.path, ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,channels,channel_layout', '-of', 'json', output])).streams[0];
      assert.equal(stream.codec_name, 'aac');
      assert.equal(stream.channels, 2);
      const decoded = exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', output,
        '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', 'pipe:1'], { raw: true });
      const sums = [0, 0];
      const samples = Math.floor(decoded.length / 8);
      for (let i = 0; i < samples; i++) {
        for (let channel = 0; channel < 2; channel++) {
          const value = decoded.readFloatLE(i * 8 + channel * 4);
          sums[channel] += value * value;
        }
      }
      for (const [index, power] of sums.entries()) {
        const rms = Math.sqrt(power / samples);
        assert.ok(rms > 0.04, `dialogue from center channel must remain audible in output ${index} (RMS ${rms})`);
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
