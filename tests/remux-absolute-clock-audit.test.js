import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

function ffmpeg(args, timeout = 20_000) {
  const process = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
    { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(process.status, 0, process.stderr || process.error?.message || `FFmpeg ${process.status}`);
  return process.stdout;
}

function firstFrameMd5(file, start = null) {
  const output = ffmpeg([
    ...(start === null ? [] : ["-ss", String(start)]),
    "-i", file, "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "framemd5", "-",
  ]);
  const frame = output.split(/\r?\n/).find((line) => /^0,/.test(line));
  assert.ok(frame, "Decoded frame hash must exist");
  return frame.split(",").at(-1).trim();
}

test("copied-video seek exposes keyframe preroll; accurate video reencode starts on requested frame", { timeout: 60_000 }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-absolute-clock-"));
  try {
    const source = path.join(directory, "source.mkv");
    const converted = path.join(directory, "seeked.mp4");
    ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000",
      "-t", "10", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
      "-threads", "2", "-preset", "ultrafast", "-g", "100", "-keyint_min", "100",
      "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "ac3",
      "-af", "volume=if(lt(t\\,5)\\,0.02\\,1):eval=frame", source]);
    ffmpeg(["-noaccurate_seek", "-ss", "5.37", "-i", source,
      "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac",
      "-b:a", "128k", "-ac", "2", "-af", "aresample=async=1",
      "-t", "4", "-avoid_negative_ts", "make_zero",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", converted]);
    const copiedFirst = firstFrameMd5(converted);
    const sourceKeyframe = firstFrameMd5(source, 4);
    const requestedFrame = firstFrameMd5(source, 5.37);
    assert.notEqual(sourceKeyframe, requestedFrame, "fixture must distinguish preroll from seek target");
    assert.equal(copiedFirst, sourceKeyframe, "copy-video source starts at preceding keyframe, even with -ss 5.37");
    const reencoded = path.join(directory, "accurate-video-reencoded.mp4");
    ffmpeg(["-ss", "5.37", "-i", source, "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-af", "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0",
      "-t", "4", "-avoid_negative_ts", "make_zero",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", reencoded]);
    // Unlike audio packet continuity, subtitle timing requires the player to
    // know which absolute source frame appears at the output stream's t=0.
    // A copied seek needs a true keyframe clock; a decoded/reencoded seek can
    // keep the requested clock at the cost of another video encode.
    assert.notEqual(copiedFirst, requestedFrame, "requested clock is not valid for copied stream");
    assert.equal(firstFrameMd5(reencoded), requestedFrame, "accurate reencode starts on the desired movie frame");
    const speech = path.join(directory, "speech.pcm");
    const fromKeyframe = path.join(directory, "from-keyframe.pcm");
    const rawSpeech = (start, output, filter = "highpass=f=120,lowpass=f=4000") => ffmpeg([
      ...(start === 5.37 ? ["-noaccurate_seek"] : []), "-ss", String(start), "-i", source,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000",
      "-af", filter, "-t", "3", "-f", "s16le", "-y", output,
    ]);
    rawSpeech(5.37, speech, "aresample=async=1:first_pts=0,highpass=f=120,lowpass=f=4000");
    rawSpeech(4, fromKeyframe);
    const windowRms = (samples, fromSeconds, durationSeconds) => {
      let sum = 0;
      const from = Math.round(fromSeconds * 16000), count = Math.round(durationSeconds * 16000);
      for (let i = from; i < from + count; i += 1) {
        const value = samples.readInt16LE(i * 2) / 32768;
        sum += value * value;
      }
      return Math.sqrt(sum / count);
    };
    const videoKeyframeAudio = windowRms(fs.readFileSync(fromKeyframe), 0.1, 0.3);
    const tappedSeekAudio = windowRms(fs.readFileSync(speech), 0.1, 0.3);
    assert.ok(tappedSeekAudio > videoKeyframeAudio * 10,
      `the separate speech-tape resampler trims keyframe audio preroll (${videoKeyframeAudio} vs ${tappedSeekAudio})`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
