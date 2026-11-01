// Transcoding a torrent's video with FFmpeg, and the encoder it uses.
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import { default as crypto } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { default as ffmpegPath } from "ffmpeg-static";
import { SPEECH_SAMPLE_RATE } from "../../shared/subtitles/subtitle-sync.js";
import { speechTapeWriter } from "../media/speech-tape.js";
import { createTranscodePlan, transcodeVideoFilter } from "../../shared/media/media-compat.js";
import { detectHardwareH264Encoder, hardwareVideoEncodingArgs } from "../media/hardware-transcode.js";
import { pruneExitedTranscodes } from "../media/transcode-slot-lifecycle.js";
import { pipeRemuxAhead } from "../media/remux-run-ahead.js";
import { isTorrentFileFullyVerified } from "../media/verified-torrent-file.js";
import { evaluateEncodedH264CacheEligibility } from "../media/transcode-cache-eligibility.js";
import {
  activeTranscodes, indexedVideoCache, MAX_TORRENT_VIDEO_BYTES, MAX_TRANSCODE_JOBS, playbackTrace,
  port, progressiveIndexCache, remuxSegmentCache, storage, torrentSessions, VIDEO_EXTENSIONS,
} from "../../server.js";
import { json } from "../app/http-helpers.js";
import {
  internalTorrentSource, rejectOversizeVideo, scheduleSessionExpiry, trackOpenStream,
} from "../torrents/torrent-sessions.js";
import { copiedSeekOrigin } from "./torrent-stream.js";
import { getCachedMediaProbe, probeTorrentFile } from "../media/torrent-probe.js";

// Only the optional, short, verified SDR encoded-output cache needs a precise
// FFmpeg binary identity. Hash its real bytes lazily, once, with bounded
// streaming memory; ordinary playback must not pay this startup cost.
let ffmpegBinaryFingerprintPromise = null;
async function exactFfmpegFingerprint() {
  if (!ffmpegPath) return null;
  if (!ffmpegBinaryFingerprintPromise) {
    ffmpegBinaryFingerprintPromise = (async () => {
      const digest = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(ffmpegPath, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
      return digest.digest("hex");
    })().catch(() => null);
  }
  return ffmpegBinaryFingerprintPromise;
}

let preferredHardwareEncoderPromise = null;
let failedHardwareEncoder = "";
async function videoTranscodeEncoder() {
  if (!preferredHardwareEncoderPromise) preferredHardwareEncoderPromise = detectHardwareH264Encoder(ffmpegPath);
  const encoder = await preferredHardwareEncoderPromise;
  return encoder && encoder !== failedHardwareEncoder ? encoder : "libx264";
}

export async function transcodeTorrentFile(req, res, session, fileIndex, requestUrl = null) {
  const traceToken = typeof playbackTrace !== "undefined" ? playbackTrace.captureToken(session.id, fileIndex) : null;
  const tracing = Boolean(traceToken);
  const file = session.torrent.files[fileIndex];
  if (!file) {
    json(res, 404, { error: "Torrent file not found" });
    return;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 415, { error: "Selected torrent file is not a supported video file" });
    return;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    json(res, 413, { error: `Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` });
    return;
  }
  if (rejectOversizeVideo(res, file)) return;
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  let media = getCachedMediaProbe(session.id, fileIndex);
  // Do not block playback startup on FFprobe. Duration is loaded by the client
  // independently and cached for later requests; FFmpeg can start immediately.

  let sourceUrl = `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const requestedStart = Number(requestUrl?.searchParams?.get("start") || 0);
  const requestedAudio = Number(requestUrl?.searchParams?.get("audio") || 0);
  const maximumStart = media?.durationSeconds ? Math.max(0, Number(media.durationSeconds) - 0.25) : requestedStart;
  const startSeconds = Number.isFinite(requestedStart) && requestedStart > 0
    ? Math.max(0, Math.min(requestedStart, maximumStart))
    : 0;
  const truthyParam = (name) => /^(?:1|true|yes)$/i.test(String(requestUrl?.searchParams?.get(name) || ""));
  const requestedVideoMode = requestUrl?.searchParams?.get("video") || "auto";
  // Explicit copy must never quietly turn a seeked HDR source into SDR just
  // because media metadata is not yet cached when the video is reopened.
  if (startSeconds > 0 && requestedVideoMode === "copy" && !media) {
    try { media = await probeTorrentFile(session, fileIndex); }
    catch (error) {
      if (!res.destroyed && !res.writableEnded) json(res, error.statusCode || 422, { error: "Cannot verify source compatibility for copied-video seeking" });
      return;
    }
  }
  const audioTracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
  const audioTrackOrder = Number.isInteger(requestedAudio) && requestedAudio >= 0 && requestedAudio < Math.max(1, audioTracks.length)
    ? requestedAudio
    : 0;
  const plan = createTranscodePlan(media, {
    fileName: file.name,
    startSeconds,
    audioTrackOrder,
    audioMode: requestUrl?.searchParams?.get("audioMode") || (truthyParam("surround") ? "surround" : "stereo"),
    videoMode: requestedVideoMode,
    clientHevc: truthyParam("hevc"),
    clientAv1: truthyParam("av1"),
  });
  if (tracing) playbackTrace.plan(session.id, fileIndex, {
    videoMode: plan.video.mode, videoReason: plan.video.fallbackReason,
    sourceVideoCodec: plan.video.sourceCodec, audioMode: plan.audio.mode,
    audioReason: plan.audio.reason, audioOutputCodec: plan.audio.outputCodec,
    audioOutputChannels: plan.audio.channels, startSeconds,
  }, traceToken);
  if (startSeconds > 0 && requestedVideoMode === "copy" && plan.video.hdrKind && plan.video.mode !== "copy") {
    json(res, 422, { error: "This HDR video cannot be safely copied with the requested browser codec capabilities" });
    return;
  }
  let effectiveStartSeconds = startSeconds;
  if (startSeconds > 0 && plan.video.mode === "copy") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const origin = await copiedSeekOrigin(session, fileIndex, startSeconds, controller.signal);
      effectiveStartSeconds = origin.effectiveStartSeconds;
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded)
        json(res, error.statusCode && error.statusCode !== 499 ? error.statusCode : 422,
          { error: "Copied-video source clock could not be verified; video was not downgraded" });
      return;
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  }
  // In copied-video mode -noaccurate_seek retains the preceding GOP for both
  // streams. -t must cover that preroll, or audio gets cut before the final
  // video frames near EOF. Keep -ss at the requested time: changing it to the
  // keyframe origin alters FFmpeg's seek and breaks verified A/V alignment.
  const durationOrigin = plan.video.mode === "copy" ? effectiveStartSeconds : startSeconds;
  const remainingDuration = media?.durationSeconds ? Math.max(0.25, Number(media.durationSeconds) - durationOrigin) : null;
  const videoFilter = transcodeVideoFilter(plan);
  const videoEncoder = plan.video.mode === "copy" ? "copy" : await videoTranscodeEncoder();
  if (res.destroyed || res.writableEnded) return;
  // Fragment caches are strictly bound to their exact validated movie clock,
  // source, audio track and FFmpeg plan. Only an EOF-verified complete fMP4 is
  // safe for a native HTMLMediaElement replay. Partial moofs stay internal.
  let remuxIdentity = plan.video.mode === "copy" ? {
    sessionId: session.id, sourceIdentity: session.infoHash, fileIndex,
    sourceLength: Number(file.length), startSeconds, effectiveStartSeconds,
    remainingDuration, videoMode: plan.video.mode,
    videoCodec: plan.video.sourceCodec || "unknown", videoTag: plan.video.tag || null,
    audioTrack: audioTrackOrder, audioMode: plan.audio.mode,
    audioCodec: plan.audio.codec, audioChannels: plan.audio.channels,
    audioBitrate: plan.audio.bitRate || null, audioFilter: plan.audio.codec === "copy" ? null : "aresample=async=1",
  } : null;
  // Only short, fully downloaded, FFprobe-verified 8-bit SDR conversions may
  // save an exact-plan H264/AAC output for replay on a repeat request. The
  // recorder verifies complete EOF and the shared cache enforces a hard
  // per-record 64MiB cap. This never authorizes an HEVC/HDR MSE warm seek.
  let encodedAdmission = null;
  if (!remuxIdentity && startSeconds > 0 && plan.video.mode === "h264"
    && videoEncoder === "libx264" && media?.durationSeconds
    && remainingDuration > 0 && remainingDuration <= 180
    && typeof storage !== "undefined"
    && typeof isTorrentFileFullyVerified === "function"
    && storage.limits().remuxCacheEnabled === true
    && isTorrentFileFullyVerified(session.torrent, fileIndex)) {
    const estimatedOutputBytes = Math.ceil(
      Number(file.length) * remainingDuration / Math.max(1, Number(media.durationSeconds)));
    if (Number.isSafeInteger(estimatedOutputBytes) && estimatedOutputBytes >= 4096
      && estimatedOutputBytes <= 32 * 1024 * 1024) {
      try {
        const allowance = await storage.playerCacheAllowance({
          additionalBytes: 2 * estimatedOutputBytes + 4 * 1024 * 1024,
          reservedSourceBytes: 0,
        });
        if (allowance.allowed && !res.destroyed && !res.writableEnded
          && torrentSessions.get(session.id) === session) {
          const audioFilter = plan.audio.codec === "copy" ? null
            : "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0";
          const ffmpegFingerprint = await exactFfmpegFingerprint();
          // Fingerprinting is asynchronous. A removed/replaced torrent must
          // not even acquire cache admission under a now-stale source ID.
          if (res.destroyed || res.writableEnded) return;
          if (torrentSessions.get(session.id) !== session) {
            if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
            else res.destroy();
            return;
          }
          const decision = evaluateEncodedH264CacheEligibility({
            sessionId: session.id, sourceIdentity: session.infoHash, fileIndex,
            sourceLength: Number(file.length), media,
            verifiedProbe: getCachedMediaProbe(session.id, fileIndex) === media,
            plan, startSeconds, effectiveStartSeconds, remainingDuration,
            audioTrackOrder, videoEncoder,
            videoEncodingArgs: hardwareVideoEncodingArgs(videoEncoder, media.video?.height),
            videoFilter, audioFilter, ffmpegFingerprint,
            availableCacheBytes: allowance.availableBytes,
            reservedSourceBytes: 0, estimatedOutputBytes,
            activeTranscodes: activeTranscodes.size,
          });
          if (decision.eligible) {
            encodedAdmission = decision;
            remuxIdentity = decision.identity;
          }
        }
      } catch { /* Cache admission is optional; foreground playback proceeds. */ }
    }
  }
  // Computing an optional encoded-cache fingerprint can yield for an entire
  // file read. Never start a cached conversion for a session retired meanwhile.
  // Unchanged legacy non-cached routes do not acquire an extra session guard.
  if (res.destroyed || res.writableEnded) return;
  if (encodedAdmission && typeof torrentSessions !== "undefined"
    && torrentSessions.get(session.id) !== session) {
    // A session can be deleted while the optional FFmpeg binary hash is read.
    // Do not leave a still-connected HTTP request hanging indefinitely.
    if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
    else res.destroy();
    return;
  }
  const outputHeaders = () => ({
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
    "X-Blackline-Transcode": `${plan.video.mode}-${plan.audio.codec}`,
    "X-Media-Video-Mode": plan.video.mode,
    "X-Media-Video-Source-Codec": plan.video.sourceCodec || "unknown",
    "X-Media-Video-Output-Codec": plan.video.mode === "copy" ? (plan.video.sourceCodec || "unknown") : "h264",
    "X-Media-Video-Encoder": videoEncoder,
    "X-Media-Video-Keyframe-Seek": plan.video.keyframeSeek ? "1" : "0",
    "X-Media-Audio-Mode": plan.audio.mode,
    "X-Media-Audio-Channels": String(plan.audio.channels),
    "X-Media-Audio-Output-Codec": plan.audio.outputCodec || "none",
    "X-Media-Audio-Output-Bitrate": plan.audio.bitRate || "original",
    "X-Media-Audio-Reason": plan.audio.reason,
    ...(plan.video.hdrKind ? { "X-Media-HDR-Source": plan.video.hdrKind } : {}),
    ...(plan.video.hdrKind ? { "X-Media-HDR-Output": plan.video.mode === "copy" ? plan.video.hdrKind : "sdr-bt709" } : {}),
    ...(plan.video.fallbackReason ? { "X-Media-Video-Fallback": plan.video.fallbackReason } : {}),
    "X-Media-Start-Seconds": String(startSeconds),
    "X-Media-Effective-Start-Seconds": String(effectiveStartSeconds),
    "X-Audio-Track-Index": String(audioTrackOrder),
    ...(media?.durationSeconds ? { "X-Media-Duration-Seconds": String(media.durationSeconds) } : {}),
  });
  if (remuxIdentity && typeof remuxSegmentCache !== "undefined") {
    // A lease pins this exact reader across concurrent session cleanup and
    // option toggles; it is released after EOF or HTTP disconnect.
    const complete = await remuxSegmentCache.openComplete(remuxIdentity);
    // A superseded seek can disconnect while the optional cache lookup
    // waits for an earlier recorder to finish. A MISS is still asynchronous:
    // without this guard the old request spawns an orphan FFmpeg after its
    // abort/close events have already fired, consuming one of only two slots.
    if (res.destroyed || res.writableEnded || req.aborted) {
      await complete?.release();
      return;
    }
    if (complete) {
      let cacheStream = null;
      try {
        if (res.destroyed || res.writableEnded) { await complete.release(); return; }
        cacheStream = complete.handle.createReadStream({ start: 0,
          end: complete.bytes - 1, autoClose: false });
        res.writeHead(200, { ...outputHeaders(), "Content-Length": String(complete.bytes),
          "X-LVL-Remux-Cache": "complete-hit" });
        trackOpenStream(session, res, fileIndex);
        // Closing the HTTP response also destroys a paused disk source.
        res.once("close", () => cacheStream.destroy());
        void pipeline(cacheStream,res).catch(() => {
          if (!res.destroyed) res.destroy();
        }).finally(() => complete.release());
        return;
      } catch {
        if (cacheStream)cacheStream.destroy();
        await complete.release();
        if (res.headersSent) { res.destroy(); return; }
      }
    }
  }
  // Recheck after ALL async cache/admission work. The client may have moved
  // to another episode or disposed this source before FFmpeg is spawned.
  if (res.destroyed || res.writableEnded || req.aborted) return;
  if (typeof torrentSessions !== "undefined" && torrentSessions.get(session.id) !== session) {
    if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
    else res.destroy();
    return;
  }
  // Encoder detection is asynchronous. Two other requests can have claimed
  // slots while this request awaited it; re-check immediately before spawn.
  // A dead encoder can remain in this Set if Windows never completes its
  // ChildProcess "close" event (for example, when an auxiliary pipe stalls).
  // Reclaim only confirmed exited PIDs before rejecting an otherwise valid
  // conversion. Do not kill or unpipe any live FFmpeg.
  pruneExitedTranscodes(activeTranscodes);
  // Foreground seeks outrank offline encoding, but don't throw away a
  // half-built whole-episode rendition while a spare FFmpeg slot exists.
  // Preempt only when admission would otherwise hit the two-slot ceiling;
  // stopAll waits for actual child close before the next admission check.
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) {
    await progressiveIndexCache.stopAll();
    if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) await indexedVideoCache.stopAll();
  }
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) {
    json(res, 429, { error: "Too many videos are being transcoded right now" });
    return;
  }
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "conversion") : null;
  if (tagged) sourceUrl = tagged.url;
  const audioFilter = plan.audio.codec === "copy"
    ? null
    : (plan.video.mode === "copy" ? "aresample=async=1" : "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0");
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    ...(tracing ? ["-progress", "pipe:2", "-stats_period", "1"] : []),
    "-nostdin",
    // Accurate input seeking discards audio until the exact requested second,
    // but stream-copy video must start at an earlier keyframe. That creates a
    // real A/V timestamp gap (often >1s after a seek/reopened paused stream).
    // Preserve the same preroll on BOTH streams when copying video; re-encoded
    // video can still use accurate seeking because FFmpeg trims both streams.
    ...(startSeconds > 0 && plan.video.mode === "copy" ? ["-noaccurate_seek"] : []),
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", sourceUrl,
    "-map", "0:v:0",
    "-map", `0:a:${audioTrackOrder}?`,
    ...(plan.video.mode === "copy" ? ["-c:v", "copy"] : hardwareVideoEncodingArgs(videoEncoder, media?.video?.height)),
    ...(plan.video.mode === "copy"
      ? (plan.video.tag ? ["-tag:v", plan.video.tag] : [])
      : [
        "-pix_fmt", "yuv420p",
        ...(videoFilter ? ["-vf", videoFilter] : []),
        ...(encodedAdmission ? ["-force_key_frames", "expr:gte(t,n_forced*2)"] : []),
        ...(plan.video.toneMapToSdr ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : []),
      ]),
    "-c:a", plan.audio.codec,
    ...(plan.audio.codec === "copy" ? [] : [
      "-b:a", plan.audio.bitRate,
      "-ac", String(plan.audio.channels),
      ...(audioFilter ? ["-af", audioFilter] : []),
    ]),
    ...(remainingDuration ? ["-t", String(remainingDuration)] : []),
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
    // Second output: the same audio as 16 kHz mono speech band, kept as loudness per 10 ms for
    // subtitle sync (no extra download or decode).
    ...(audioTracks.length ? [
      "-map", `0:a:${audioTrackOrder}`,
      "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE),
      "-af", "aresample=async=1:first_pts=0,highpass=f=120,lowpass=f=4000",
      "-f", "s16le", "pipe:3",
    ] : []),
  ];

  const ffmpeg = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  activeTranscodes.add(ffmpeg);
  scheduleSessionExpiry(session);
  trackOpenStream(session, res, fileIndex);
  if (audioTracks.length && ffmpeg.stdio[3]) {
    const tape = speechTapeWriter(session.id, fileIndex, audioTrackOrder, startSeconds);
    ffmpeg.stdio[3].on("data", (chunk) => tape.push(chunk));
    ffmpeg.stdio[3].once("close", () => tape.end());
    ffmpeg.stdio[3].on("error", () => {});
  }

  let stderr = "";
  let progressBuffer = "";
  ffmpeg.stderr.on("data", (chunk) => {
    if (tracing) {
      progressBuffer = (progressBuffer + chunk.toString("utf8")).slice(-4096);
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) playbackTrace.progress(session.id, line.trim(), traceToken);
    }
    if (stderr.length < 8192) stderr += chunk.toString("utf8");
  });

  const remuxRecorder = remuxIdentity && typeof remuxSegmentCache !== "undefined"
    ? remuxSegmentCache.begin(remuxIdentity,
      encodedAdmission ? { maxEntryBytes: encodedAdmission.maxOutputBytes } : undefined) : null;
  // Only verified, already fully downloaded local pieces may run independently
  // of browser HTTP backpressure. This is SAME-FFmpeg, SAME-producer-token
  // buffering, not a second torrent reader or a new conversion job. A client
  // must explicitly opt into the MSE consumer; native streams remain unchanged.
  const runAheadEligible = Boolean(remuxRecorder && truthyParam("mse")
    && plan.video.mode === "copy" && plan.video.sourceCodec === "h264"
    && plan.audio.outputCodec === "aac" && !plan.video.hdrKind
    && isTorrentFileFullyVerified(session.torrent, fileIndex));
  res.writeHead(200,{...outputHeaders(),
    ...(remuxRecorder?{"X-LVL-Remux-Producer":remuxRecorder.producerToken}:{}),
    ...(runAheadEligible?{"X-LVL-Remux-Run-Ahead":"verified-local-bounded"}:{})});
  res.flushHeaders?.();
  ffmpeg.stdout.on("error", () => res.destroy());
  if (remuxRecorder) {
    remuxRecorder.transform.on("error", () => res.destroy());
    if (runAheadEligible) {
      // The recorder sees verified fragments beyond the browser's +45s MSE
      // read limit. 96MiB of queued output is the HARD cap; once full, normal
      // backpressure pauses this very same FFmpeg and its cache writer.
      const generation = remuxRecorder.producerToken;
      const current = () => torrentSessions.get(session.id) === session
        && session.torrent?.files?.[fileIndex] === file;
      const ahead = pipeRemuxAhead({
        source:remuxRecorder.transform, response:res,sourceGeneration:generation,
        getCurrentGeneration:()=>current()?generation:null,
        isVerifiedComplete:()=>current() && file.done === true && Number(file.downloaded) === Number(file.length),
        maxBufferedBytes:96*1024*1024,
        onAbort:()=>{if(!ffmpeg.killed)ffmpeg.kill();},
      });
      if (ahead.started) {
        ffmpeg.stdout.pipe(remuxRecorder.transform);
        void ahead.done.then((result)=>{
          if(!result.completed && !res.destroyed)res.destroy();
        });
      } else ffmpeg.stdout.pipe(remuxRecorder.transform).pipe(res);
    } else ffmpeg.stdout.pipe(remuxRecorder.transform).pipe(res);
  } else ffmpeg.stdout.pipe(res);

  let cancelledByClient = false;
  let childClosed = false;
  let stopEscalation = null;
  const stop = () => {
    if (res.writableFinished || cancelledByClient) return;
    cancelledByClient = true;
    // Node unpipes a closed HTTP response but does not destroy the upstream
    // streams. A paused stdout/recorder can keep ChildProcess "close" pending
    // after FFmpeg has exited, stranding slots and incomplete cache records.
    // This teardown is ONLY for a disconnected client; successful streams
    // must keep their original pipe chain until the final MP4 atom drains.
    try { if (!ffmpeg.killed) ffmpeg.kill(); } catch { /* escalate below */ }
    stopEscalation = setTimeout(() => {
      if (!childClosed) {
        try { ffmpeg.kill("SIGKILL"); } catch { /* retain slot until close */ }
      }
    }, 2_000);
    stopEscalation.unref?.();
    ffmpeg.stdout.unpipe();
    ffmpeg.stdout.destroy();
    remuxRecorder?.transform.destroy();
    // The optional speech side-channel is another ChildProcess stdio pipe.
    // Once the movie response is cancelled its output must not pin close.
    ffmpeg.stdio[3]?.destroy();
  };
  req.once("aborted", stop);
  res.once("close", stop);

  ffmpeg.once("error", (error) => {
    tagged?.release();
    void remuxRecorder?.finish({ success: false });
    // Node may emit ChildProcess "error" before its stdio and process have
    // actually closed. Releasing the slot here could admit a replacement
    // FFmpeg while this failed child still owns pipes or file handles.
    // The "close" listener below is the sole slot-release owner.
    console.warn(`FFmpeg failed for ${file.name}:`, error.message);
    if (!res.headersSent) json(res, 500, { error: "Unable to start FFmpeg transcode" });
    else res.destroy();
  });
  ffmpeg.once("close", (code) => {
    childClosed = true;
    clearTimeout(stopEscalation);
    tagged?.release();
    if (remuxRecorder) {
      // ChildProcess close does not mean the optional Transform has finished
      // draining FFmpeg's stdout. Finalizing now can drop its final MP4 atom.
      // The recorder is optional, so never let it end the browser's response.
      const settleRecorder = () => void remuxRecorder.finish({
        success: code === 0 && !cancelledByClient
          && ffmpeg.stdout.readableEnded && remuxRecorder.transform.writableFinished,
      });
      if (remuxRecorder.transform.writableFinished || !ffmpeg.stdout.readableEnded)
        settleRecorder();
      else {
        remuxRecorder.transform.once("finish", settleRecorder);
        remuxRecorder.transform.once("close", settleRecorder);
      }
    }
    activeTranscodes.delete(ffmpeg);
    if (code && videoEncoder !== "copy" && videoEncoder !== "libx264" && !cancelledByClient) {
      failedHardwareEncoder = videoEncoder;
      console.warn(`Hardware encoder ${videoEncoder} failed; future streams will use software H.264`);
    }
    req.removeListener("aborted", stop);
    // Keep the response-close listener through the final pipe drain: a client
    // can still disconnect after the child exits while bytes remain queued.
    if (code && stderr.trim()) console.warn(`FFmpeg exited ${code} for ${file.name}: ${stderr.trim().slice(-1200)}`);
    // stdout.pipe(recorder?).pipe(res) (or the bounded run-ahead pipeline)
    // must own end-of-response. Calling res.end() at child close truncates
    // buffered fMP4 output for a slow consumer and causes media decode errors.
  });
}
